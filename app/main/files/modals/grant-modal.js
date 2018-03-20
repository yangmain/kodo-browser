angular.module('web')
  .controller('grantModalCtrl', ['$scope', '$q', '$uibModalInstance','$translate', 'items', 'currentInfo','ramSvs','settingsSvs','subUserAKSvs','Mailer','Const','Toast','AuthInfo', 'safeApply',
    function ($scope, $q, $modalInstance, $translate, items, currentInfo,ramSvs, settingsSvs, subUserAKSvs, Mailer, Const, Toast, AuthInfo, safeApply) {
      var T = $translate.instant;
      angular.extend($scope, {
        cancel: cancel,
        policyChange: policyChange,
        onSubmit: onSubmit,
        genUserName: genUserName,
        items: items,
        reg:{
          email: Const.REG.EMAIL,
        },
        create: {
          UserName: '',
          Email: ''
        },
        grant: {
          toTypes: ['group', 'user', 'role'],
          toType: 'user',
          privTypes: ['readOnly','all'],
          privType: 'readOnly',
        },
        policyNameReg: /^[a-z0-9A-Z\-]{1,128}$/,
        mailSmtp: settingsSvs.mailSmtp.get(),
        showEmailSettings: function(){
          $scope.showSettings(function(){
            $scope.mailSmtp= settingsSvs.mailSmtp.get();
          })
        }
      });

      init();
      function init(){

        policyChange();
        var ignoreError = true;

        ramSvs.listUsers(ignoreError).then(function(result){
           $scope.users = result;
        }, function(err){
          $scope.users = [];
          if(err.message.indexOf('You are not authorized to do this action')!=-1){
            Toast.error(T('simplePolicy.noauth.message1')); //'没有权限获取用户列表'
          }
        });
        ramSvs.listGroups(ignoreError).then(function(result){
           $scope.groups = result;
        },function(err){
          $scope.groups = [];
          if(err.message.indexOf('You are not authorized to do this action')!=-1){
            Toast.error(T('simplePolicy.noauth.message2')); //'没有权限获取用户组列表'
          }
        });
        ramSvs.listRoles(ignoreError).then(function(result){
           $scope.roles = result;
        },function(err){
          $scope.roles = [];

          if(err.message.indexOf('You are not authorized to do this action')!=-1){
            Toast.error(T('simplePolicy.noauth.message3')); //'没有权限获取角色列表'
          }
        });
      }

      //Object的读操作包括：GetObject，HeadObject，CopyObject和UploadPartCopy中的对source object的读；
      //Object的写操作包括：PutObject，PostObject，AppendObject，DeleteObject，DeleteMultipleObjects，CompleteMultipartUpload以及CopyObject对新的Object的写。

      function cancel() {
        $modalInstance.dismiss('close');
      }

      function genPolicy(privType) {
        var t = [];

        var actions = [];
        if(privType=='readOnly'){
          actions = ['s3:GetObject',
            's3:HeadObject',
            "s3:GetObjectMeta",
            "s3:GetObjectACL",
            's3:ListObjects',
            's3:GetSymlink'
          ];
        }
        else{
          actions = ['s3:*'];
        }

        angular.forEach($scope.items, function (item) {
          if (item.region || item.isFolder) {

            var bucket = item.region?item.name: currentInfo.bucket;
            var key = item.path||'';
            t.push({
              "Effect": "Allow",
              "Action": actions,
              "Resource": [
                "acs:s3:*:*:" + bucket + "/" + key + "*"
              ]
            });


            t.push({
              "Effect": "Allow",
              "Action": [
                "s3:ListObjects"
              ],
              "Resource": [
                "acs:s3:*:*:" + bucket
              ],
              "Condition": {
                "StringLike": {
                  "s3:Prefix": key + "*"
                }
              }
            });

          } else {
            //文件所有权限
            t.push({
              "Effect": "Allow",
              "Action": actions,
              "Resource": [
                "acs:s3:*:*:" + currentInfo.bucket + "/" + item.path
              ]
            });
          }
        });

        return {
          "Version": "1",
          "Statement": t
        };
      }

      var policy;
      function policyChange(){
        var privType = $scope.grant.privType;
        policy = genPolicy(privType);
        $scope.grant.policy = JSON.stringify(policy,' ',2);

        var name =  (Math.random()+'').substring(2);
        if($scope.items && $scope.items.length==1){
          name = $scope.items[0].name;//.replace(/[\W_]+/g,'-');
        }
        $scope.grant.policyName = 'plc-'+ privType +'-'+ name;
      }

      function onSubmit(form1) {
        if (!form1.$valid) return false;


        checkCreateUser(function(username, sendInfo){

          if(username){
            $scope.grant.userName = username;
            ramSvs.listUsers(true).then(function(result){
               $scope.users = result;
            });
          }

          var policyName= $scope.grant.policyName;

          var title = T('simplePolicy.title');//简化policy授权
          var successMsg = T('simplePolicy.success');//'应用policy成功'
          checkCreatePolicy(policyName, $scope.grant.policy, title).then(function(){
            switch($scope.grant.toType){
              case 'user':
                ramSvs.attachPolicyToUser(policyName, $scope.grant.userName).then(function(){
                  //发邮件
                  if(sendInfo) Mailer.send(sendInfo).then(function(result){
                    console.log(result)
                    Toast.success(T('mail.test.success'));
                  },function(err){
                    console.error(err);
                    Toast.error(err);
                  });


                  Toast.success(successMsg);
                  cancel();
                });
                break;
              case 'group':
                ramSvs.attachPolicyToGroup(policyName, $scope.grant.groupName).then(function(){
                  Toast.success(successMsg);
                  cancel();
                });
                break;
              case 'role':
                ramSvs.attachPolicyToRole(policyName, $scope.grant.roleName).then(function(){
                  Toast.success(successMsg);
                  cancel();
                });
                break;
            }
          });
        });

      }
      function genUserName(){
        $scope.create.UserName = 'usr-'+new Date().getTime()+ ((Math.random()+'').substring(10));
      }

      function checkCreatePolicy(policyName, policy, title){
        var df = $q.defer();
        return ramSvs.getPolicy(policyName, 'Custom', true).then(function(result){
          console.log('getPolicy:',result);
          df.resolve(result.Policy);
        },function(err){
          ramSvs.createPolicy(policyName, policy, title).then(function(result){
            console.log('createPolicy:',result);
            df.resolve(result.Policy);
          },function(err){
            df.reject(err);
          })
        });
        return df.promise;
      }

      function checkCreateUser(fn){
        if($scope.grant.toType!='user'){
          fn();
          return;
        }

        if($scope.grant.userName){
          fn($scope.grant.userName);
        }else{
          var userName = $scope.create.UserName;
          var comments = [];
          angular.forEach($scope.items, function(n){
             comments.push('s3://'+currentInfo.bucket + "/" + n.path);
          });
          ramSvs.createUser({
            UserName: userName,
            Email: $scope.create.Email,
            Comments: ($scope.grant.privType+','+comments.join(',')).substring(0,100)
          }).then(function(){

            ramSvs.createAccessKey(userName).then(function(result){
              //AccessKeyId
              //console.log(result.AccessKey);
              var id = result.AccessKey.AccessKeyId;
              var secret = result.AccessKey.AccessKeySecret;
              subUserAKSvs.save({
                AccessKeyId: id,
                AccessKeySecret: secret,
                UserName: userName
              });

              var sendInfo = getSendInfo(id,secret,userName, currentInfo.region, comments,$scope.create.Email, $scope.grant.privType);
              fn(userName, sendInfo);
            });

          });
        }
      }


      function getSendInfo(id, secret, userName, region, comments, toEmail, privType){
        var opt = {
          id: id,
          secret: secret,
          desc: userName,
          region:  region,
          s3path: comments[0],
          eptpl: AuthInfo.get().eptpl || 'http://{region}.qiniu.com'
        };

        var tokenStr = new Buffer(JSON.stringify(opt)).toString('base64');

         var sendInfo = {
          //  AccessKeyId: result.AccessKey.AccessKeyId,
          //  AccessKeySecret: result.AccessKey.AccessKeySecret,
          //  UserName: userName,
           subject:  T('grant.email.title'),// 'S3 Browser 授权',
           to: toEmail,
           html:
`${T('grant.email.body.title')}<br/>
<br/>
1. ${T('auth.accessLogin')}:<br/>
<br/>
子用户名(Sub User): ${userName}<br/>
AccessKeyId: ${id}<br/>
AccessKeySecret: ${secret}<br/>
区域(Region): ${region}<br/>
授权路径(s3path): ${comments.join(',<br/>')}<br/>
授予权限(permission): ${privType}<br/>
<br/>

2. ${T('auth.passlogin')}:<br/><br/>

<code>${tokenStr}</code>

<br/>
<hr/>
您可以使用 <a href="https://github.com/aliyun/s3-browser" target="_blank">S3 Browser</a> 浏览或管理这些文件。
`
                   //   '子用户名(Sub User): '+userName+ '<br/>'
                   // + 'AccessKeyId: '+result.AccessKey.AccessKeyId+ '<br/>'
                   // + 'AccessKeySecret: '+ result.AccessKey.AccessKeySecret+ '<br/>'
                   // + '区域(Region): '+ currentInfo.region  + '<br/>'
                   // + '授予权限(permission): '+$scope.grant.privType + '<br/>'
                   // + '授权路径(s3path): ' + comments.join(',<br/>')
                   // + '<hr/>'
                   // + '您可以使用 <a href="https://github.com/aliyun/s3-browser" target="_blank">S3 Browser</a> 浏览或管理这些文件。'
         };
         return sendInfo;
      }

    }
  ]);
