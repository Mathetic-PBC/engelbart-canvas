'use strict';
// Independent, read-only checks of the pinned fixtures. Not runtime policy.
const { quote } = require('../sandbox-cache/common.cjs');
const checks = {
  'kjfeng/cocoa-canvas': { port: 3001, path: '/api/health', expected: '"status":"ok"' },
  'mqo00/hypocompass': { port: 8090, path: '/', expected: 'login' },
};
async function verifyServices(sandbox, repository) {
  const check = checks[repository.name];
  if (!check) return { ok: true, checks: [], note: 'No separate backend in this pinned fixture' };
  const program = `import sys,json,urllib.request
sys.path.insert(0,'/home/user/.engelbart-canvas')
import launch
check=json.loads(${JSON.stringify(JSON.stringify(check))})
record=launch.read_json(launch.STATE/'app.json',None)
processes=launch.process_snapshot()
owned=launch.app_owned(record,processes) if record else {}
listeners=launch.app_listeners(processes,owned,check['port'])
result={'port':check['port'],'path':check['path'],'ok':False,'owned':False}
for row in listeners:
 if row['port']!=check['port'] or row['ownership']!='owned': continue
 result['owned']=True
 host={'0.0.0.0':'127.0.0.1','127.0.0.1':'127.0.0.1','::':'[::1]','::1':'[::1]'}.get(row['address'])
 if not host: continue
 try:
  with urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://'+host+':'+str(check['port'])+check['path'],timeout=3) as response:
   body=response.read(2048).decode(errors='replace')
   result.update(status=response.status,expected_content=check['expected'] in body.replace(' ',''))
   result['ok']=response.status==200 and result['expected_content']
  if result['ok']: break
 except Exception as error: result['error']=type(error).__name__
print(json.dumps({'ok':result['ok'],'checks':[result]}))`;
  const result = await sandbox.commands.run(`python3 -c ${quote(program)}`, { timeoutMs: 15_000 });
  return JSON.parse(result.stdout);
}
module.exports = { verifyServices };
