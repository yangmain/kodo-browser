'use strict';

let AWS = require('aws-sdk'),
  EventEmitter = require('events').EventEmitter,
  fs = require('fs'),
  mime = require('mime'),
  {
    ReadableStream
  } = require('./stream');

const {
  MIN_MULTIPART_SIZE,
  MAX_PUTOBJECT_SIZE,
  MAX_MULTIPART_COUNT
} = require('./consts');

exports.AWS = AWS;
exports.Client = Client;

exports.createClient = function (options) {
  return new Client(options);
};

function Client(options) {
  options = options ? options : {};

  this.s3 = options.s3Client || new AWS.S3(options.s3Options);
  this.s3concurrency = options.maxConcurrency || 10; // multipart io limitation!

  this.resumeUpload = options.resumeUpload === true;
  this.multipartUploadThreshold = options.multipartUploadThreshold || (MIN_MULTIPART_SIZE * 10);
  this.multipartUploadSize = options.multipartUploadSize || (MIN_MULTIPART_SIZE * 2);

  this.resumeDownload = options.resumeDownload === true;
  this.multipartDownloadThreshold = options.multipartDownloadThreshold || (MIN_MULTIPART_SIZE * 10);
  this.multipartDownloadSize = options.multipartDownloadSize || (MIN_MULTIPART_SIZE * 2);

  if (this.multipartUploadSize < MIN_MULTIPART_SIZE) {
    throw new Error('Minimum multipartUploadSize is 4MB.');
  }
  if (this.multipartUploadSize > MAX_PUTOBJECT_SIZE) {
    throw new Error('Maximum multipartUploadSize is 5GB.');
  }
  if (this.multipartUploadThreshold < MIN_MULTIPART_SIZE) {
    throw new Error('Minimum multipartUploadThreshold is 4MB.');
  }
  if (this.multipartUploadThreshold > MAX_PUTOBJECT_SIZE) {
    throw new Error('Maximum multipartUploadThreshold is 5GB.');
  }
}

Client.prototype.uploadFile = function (params) {
  let self = this;

  let localFile = params.localFile;
  let isOverwrite = params.overwriteDup;
  let isAborted = false;
  let isDebug = params.isDebug;

  let s3uploader = null;
  let s3uploadedId = params.uploadedId || null;
  let s3UploadedParts = params.uploadedParts || null;
  let s3UploadedPartSize = params.uploadedPartSize || self.multipartUploadSize;

  let uploader = new EventEmitter();
  uploader.setMaxListeners(0);
  uploader.progressLoaded = 0;
  uploader.progressTotal = 0;
  uploader.progressResumable = false;
  uploader.abort = handleAbort;

  params.s3Params.Key = encodeSpecialCharacters(params.s3Params.Key);

  let s3params = Object.assign({}, params.s3Params);
  if (s3params.ContentType === undefined) {
    let defaultContentType = params.defaultContentType || 'application/octet-stream';

    s3params.ContentType = mime.getType(localFile) || defaultContentType;
  }

  if (!isOverwrite) {
    self.s3.headObject({
      Bucket: s3params.Bucket,
      Key: s3params.Key,
    }, (err, data) => {
      if (err) {
        tryOpenFile();
      } else {
        uploader.emit("fileDuplicated", uploader);
      }
    });
  } else {
    tryOpenFile();
  }

  return uploader;

  process.on('uncaughtException', (err) => {
    handleError({
      error: err.message,
      stack: err.stack.split("\n")
    });
  });

  function handleError(err) {
    if (isAborted) return;

    if (err && err.retryable === false) {
      handleAbort();
    }

    uploader.emit('error', err);
  }

  function handleAbort() {
    isAborted = true;

    if (s3uploader) {
      s3uploader.abort();
    }

    uploader.emit('abort', {
      uploadedParts: s3UploadedParts,
      uploadedPartSize: s3UploadedPartSize
    });
  }

  function tryOpenFile() {
    fs.stat(localFile, (err, stats) => {
      if (err) {
        err.retryable = false;

        handleError(err);
        return;
      }

      let partsCount = Math.ceil(stats.size / s3UploadedPartSize);
      if (partsCount > MAX_MULTIPART_COUNT) {
        s3UploadedPartSize = smallestPartSizeFromFileSize(stats.size);
      }
      if (s3UploadedPartSize > MAX_PUTOBJECT_SIZE) {
        let err = new Error(`File size exceeds maximum object size: ${localFile}`);
        err.retryable = false;

        handleError(err);
        return;
      }

      uploader.progressLoaded = 0;
      uploader.progressTotal = stats.size;
      uploader.progressResumable = (self.resumeUpload && (s3UploadedParts === null || s3UploadedPartSize === self.multipartUploadSize));
      uploader.emit("fileStat", uploader);

      startUploadFile();
    });
  }

  function startUploadFile() {
    if (uploader.progressTotal >= self.multipartUploadThreshold) {
      if (uploader.progressResumable) {
        resumeMultipartUpload();
      } else {
        startMultipartUpload();
      }
    } else {
      tryPuttingObject((err, data) => {
        if (isAborted) return;

        if (err) {
          handleError(err);
          return;
        }

        uploader.emit('fileUploaded', data);
      });
    }
  }

  function startMultipartUpload() {
    tryMultipartUpload((err, data) => {
      if (isAborted) return;

      if (err) {
        handleError(err);
        return;
      }

      uploader.emit('fileUploaded', data);
    });

    function tryMultipartUpload(cb) {
      if (isAborted) return;

      uploader.progressLoaded = 0;
      uploader.emit('progress', uploader);

      s3uploader = new AWS.S3.ManagedUpload({
        service: self.s3,
        params: {
          Bucket: s3params.Bucket,
          Key: s3params.Key,
          Body: fs.createReadStream(localFile)
        },
        partSize: s3UploadedPartSize,
        queueSize: self.s3concurrency
      });

      s3uploader.on('httpUploadProgress', (prog) => {
        if (isAborted) return;

        uploader.progressLoaded = prog.loaded;
        uploader.emit('progress', uploader);
      });

      s3uploader.send((err, data) => {
        if (isAborted) return;

        if (err) {
          cb(err);
          return;
        }

        uploader.progressLoaded = uploader.progressTotal;
        uploader.emit('progress', uploader);

        cb(null, data);
      });
    }
  }

  function resumeMultipartUpload() {
    tryResumeMultipartUpload((err, data) => {
      if (isAborted) return;

      if (err) {
        handleError(err);
        return;
      }

      uploader.emit('fileUploaded', data);
    });

    function tryResumeMultipartUpload(cb) {
      if (isAborted) return;

      // calc uploaded progress
      let s3DoneParts = 0;
      if (s3UploadedParts) {
        s3UploadedParts.forEach((part) => {
          if (part && part.ETag !== null) {
            s3DoneParts++;

            uploader.progressLoaded += s3UploadedPartSize;
          }
        });

        uploader.emit('progress', uploader);
      } else {
        s3UploadedParts = [];
      }

      s3uploader = new AWS.S3.ManagedUpload({
        service: self.s3,
        params: {
          Bucket: s3params.Bucket,
          Key: s3params.Key,
          UploadId: s3uploadedId,
          Body: fs.createReadStream(localFile)
        },
        leavePartsOnError: true,
        partSize: s3UploadedPartSize,
        queueSize: self.s3concurrency
      });
      s3uploader.doneParts = s3DoneParts;
      s3uploader.totalUploadedBytes = uploader.progressLoaded;
      s3uploader.completeInfo = s3UploadedParts.slice(0, s3UploadedParts.length);

      s3uploader.on('httpUploadProgress', (prog) => {
        if (isAborted) return;

        s3uploader.completeInfo.forEach((part, idx) => {
          if (part.ETag !== null && !s3UploadedParts[part.PartNumber]) {
            s3UploadedParts[part.PartNumber] = part;

            uploader.emit('filePartUploaded', {
              uploadId: s3uploader.service.config.params.UploadId,
              part: part
            });
          }
        });

        uploader.progressLoaded = prog.loaded;
        uploader.emit('progress', uploader);
      });

      s3uploader.send((err, data) => {
        if (isAborted) return;

        if (err) {
          cb(err);
          return;
        }

        uploader.progressLoaded = uploader.progressTotal;
        uploader.emit('progress', uploader);

        cb(null, data);
      });
    }
  }

  function tryPuttingObject(cb) {
    s3params.ContentLength = uploader.progressTotal;
    s3params.Body = fs.createReadStream(localFile);

    s3uploader = self.s3.putObject(s3params);

    s3uploader.on('httpUploadProgress', (prog) => {
      if (isAborted) return;

      uploader.progressLoaded = prog.loaded;
      uploader.emit('progress', uploader);
    });

    s3uploader.send((err, data) => {
      if (isAborted) return;

      if (err) {
        cb(err);
        return;
      }

      uploader.progressLoaded = uploader.progressTotal;
      uploader.emit('progress', uploader);

      cb(null, data);
    });
  }
};

Client.prototype.downloadFile = function (params) {
  let self = this;

  let localFile = params.localFile;
  let isAborted = false;
  let isDebug = params.isDebug;

  let s3downloader = null;
  let s3DownloadedParts = params.downloadedParts || null;
  let s3DownloadedPartSize = params.downloadedPartSize || self.multipartDownloadSize;

  let downloader = new EventEmitter();
  downloader.setMaxListeners(0);
  downloader.progressLoaded = 0;
  downloader.progressTotal = 0;
  downloader.progressResumable = false;
  downloader.abort = handleAbort;

  params.s3Params.Key = encodeSpecialCharacters(params.s3Params.Key);

  let s3params = {};
  Object.assign(s3params, params.s3Params);

  tryOpenFile();

  return downloader;

  process.on('uncaughtException', (err) => {
    handleError({
      error: err.message,
      stack: err.stack.split("\n")
    });
  });

  function handleError(err) {
    if (isAborted) return;

    if (err && err.retryable === false) {
      handleAbort();
    }

    downloader.emit('error', err);
  }

  function handleAbort() {
    isAborted = true;

    if (s3downloader) {
      s3downloader.abort();
    }

    downloader.emit('abort', {
      downloadedParts: s3DownloadedParts,
      downloadedPartSize: s3DownloadedPartSize
    });
  }

  function tryOpenFile() {
    self.s3.headObject(s3params, (err, metadata) => {
      if (err) {
        handleError(err);
        return;
      }

      downloader.progressLoaded = 0;
      downloader.progressTotal = metadata.ContentLength;
      downloader.progressResumable = (self.resumeDownload && (!s3DownloadedParts || s3DownloadedParts.length == 0 || s3DownloadedPartSize === self.multipartDownloadSize));
      downloader.emit("fileStat", downloader);

      startDownloadFile();
    });
  }

  function startDownloadFile() {
    if (downloader.progressTotal >= self.multipartDownloadThreshold) {
      if (downloader.progressResumable) {
        resumeMultipartDownload();
      } else {
        startMultipartDownload();
      }
    } else {
      tryGettingObject((err, data) => {
        if (isAborted) return;

        if (err) {
          handleError(err);
          return;
        }

        downloader.emit('fileDownloaded', data);
      });
    }
  }

  function startMultipartDownload() {
    if (isAborted) return;

    let fileStream = fs.createWriteStream(localFile, {
      flags: 'w+',
      autoClose: true
    });

    let params = {
      Bucket: s3params.Bucket,
      Key: s3params.Key,
    };

    let s3downloader = new ReadableStream(self.s3).download(params, {
      maxRetries: self.maxRetries,
      maxPartSize: self.multipartDownloadSize,
      maxConcurrentStreams: self.s3concurrency,
      totalObjectSize: downloader.progressTotal
    });
    s3downloader.on('progress', (prog) => {
      if (isAborted) return;

      downloader.progressLoaded += prog.loaded;
      downloader.emit('progress', downloader);
    });
    s3downloader.on('part', (part) => {

    });
    s3downloader.on('error', (err) => {
      if (isAborted) return;

      handleError(err);
    });
    s3downloader.on('downloaded', (data) => {
      if (isAborted) return;

      downloader.emit('fileDownloaded');
    });
    s3downloader.pipe(fileStream);
  }

  function resumeMultipartDownload() {
    if (isAborted) return;

    let s3fsmode = fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_DIRECT;

    let fileStream = fs.createWriteStream(localFile, {
      flags: 'w+',
      autoClose: true
    });

    let params = {
      Bucket: s3params.Bucket,
      Key: s3params.Key,
    };

    let s3downloader = new ReadableStream(self.s3).download(params, {
      maxRetries: self.maxRetries,
      maxPartSize: self.multipartDownloadSize,
      maxConcurrentStreams: self.s3concurrency,
      totalObjectSize: downloader.progressTotal
    });
    s3downloader.on('progress', (prog) => {
      if (isAborted) return;

      downloader.progressLoaded += prog.loaded;
      downloader.emit('progress', downloader);
    });
    s3downloader.on('part', (part) => {
      downloader.emit('debug', part);
    });
    s3downloader.on('error', (err) => {
      if (isAborted) return;

      handleError(err);
    });
    s3downloader.on('downloaded', (data) => {
      if (isAborted) return;

      downloader.emit('fileDownloaded');
    });
    s3downloader.pipe(fileStream);
  }

  function tryGettingObject(cb) {
    if (isAborted) return;

    let fileStream = fs.createWriteStream(localFile, {
      flags: 'w+',
      autoClose: true
    });

    let params = {
      Bucket: s3params.Bucket,
      Key: s3params.Key,
    };

    s3downloader = self.s3.getObject(params).createReadStream();
    s3downloader.on('data', (chunk) => {
      if (isAborted) return;

      downloader.progressLoaded += chunk.length;
      downloader.emit('progress', downloader);
    });
    s3downloader.on('end', () => {
      if (isAborted) return;

      downloader.progressLoaded = downloader.progressTotal;
      downloader.emit('progress', downloader);

      cb(null);
    });
    s3downloader.on('error', (err) => {
      if (isAborted) return;

      cb(err);
    });

    s3downloader.pipe(fileStream);
  }
};

function encodeSpecialCharacters(filename) {
  // Note: these characters are valid in URIs, but S3 does not like them for
  // some reason.
  return filename.replace(/[!'()*]/g, function (char) {
    return '%' + char.charCodeAt(0).toString(16);
  });
}

function smallestPartSizeFromFileSize(fileSize) {
  var partSize = Math.ceil(fileSize / MAX_MULTIPART_COUNT);

  if (partSize < MIN_MULTIPART_SIZE) {
    return MIN_MULTIPART_SIZE;
  }

  return partSize + (MIN_MULTIPART_SIZE - partSize % MIN_MULTIPART_SIZE);
}