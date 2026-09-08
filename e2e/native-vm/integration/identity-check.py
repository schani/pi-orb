import base64,json,os,subprocess,urllib.request,urllib.error,time
PROJECT=os.environ['NATIVE_INTEGRATION_GCP_PROJECT']
ZONE=os.environ['NATIVE_INTEGRATION_GCP_ZONE']
SA=os.environ['NATIVE_INTEGRATION_WIF_SERVICE_ACCOUNT']
PROVIDER=os.environ['NATIVE_INTEGRATION_WIF_PROVIDER']
ORB_ID=os.environ['PI_ORB_ID']
def request(url,body=None,token=None,headers=None):
 h={'Content-Type':'application/json',**(headers or {})}
 if token:h['Authorization']='Bearer '+token
 r=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers=h)
 try:
  with urllib.request.urlopen(r,timeout=30) as res:return res.status,json.load(res)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
for audience,expected in [('pi-orb-native-integration',200),('untrusted-native-integration',400)]:
 jwt=subprocess.check_output(['pi-orb','id-token','--audience',audience],text=True).strip()
 claims=json.loads(base64.urlsafe_b64decode(jwt.split('.')[1]+'==='))
 assert claims['orb_id']==ORB_ID
 status,sts=request('https://sts.googleapis.com/v1/token',{'audience':PROVIDER,'grantType':'urn:ietf:params:oauth:grant-type:token-exchange','requestedTokenType':'urn:ietf:params:oauth:token-type:access_token','scope':'https://www.googleapis.com/auth/cloud-platform','subjectTokenType':'urn:ietf:params:oauth:token-type:jwt','subjectToken':jwt})
 assert status==expected,(status,sts.get('error_description'))
 if expected==200:
  status,imp=request('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'+SA+':generateAccessToken',{'scope':['https://www.googleapis.com/auth/cloud-platform'],'lifetime':'600s'},sts['access_token'])
  assert status==200,(status,imp.get('error'))
  status,result=request('https://cloudresourcemanager.googleapis.com/v1/projects/'+PROJECT,token=imp['accessToken'])
  assert status==200 and result['projectId']==PROJECT,(status,result.get('error'))
  print('REAL_GCP_FEDERATION_OK incarnation='+str(claims['host_incarnation']),flush=True)
 else:print('WRONG_AUDIENCE_REJECTED',flush=True)
 time.sleep(2)
status,metadata=request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',headers={'Metadata-Flavor':'Google'})
assert status==200
for label,url,body in [
 ('COMPUTE_LIST','https://compute.googleapis.com/compute/v1/projects/'+PROJECT+'/zones/'+ZONE+'/instances',None),
 ('SECRET_LIST','https://secretmanager.googleapis.com/v1/projects/'+PROJECT+'/secrets',None),
 ('SA_IMPERSONATION','https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'+SA+':generateAccessToken',{'scope':['https://www.googleapis.com/auth/cloud-platform']})]:
 status,result=request(url,body,metadata['access_token'])
 assert status==403,(label,status,result.get('error'))
 print('VM_IDENTITY_DENIED_'+label,flush=True)
