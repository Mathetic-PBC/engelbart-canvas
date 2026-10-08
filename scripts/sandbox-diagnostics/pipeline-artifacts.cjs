'use strict';

// Evidence collection only, after the timed public-preview check. No installs,
// config writes, fixes, or access to existing user sandboxes.
const fs = require('node:fs');
const path = require('node:path');
const { quote, hash } = require('../sandbox-cache/common.cjs');
const { pythonFingerprint } = require('../sandbox-cache/measure.cjs');
const ROOT = '/home/user/repository';
const REMOTE = '/home/user/install-diagnostics';

async function collectArtifacts(sandbox, record, directory, repo) {
  await sandbox.commands.run(`mkdir -p ${REMOTE}`, { timeoutMs: 10_000 });
  await sandbox.files.write(`${REMOTE}/npm.cjs`, fs.readFileSync(path.join(__dirname, 'npm.cjs'), 'utf8'));
  const program = `const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process'),path=require('node:path');
    const {packageFingerprint}=require('${REMOTE}/npm.cjs');
    const root='${ROOT}', repo=${JSON.stringify(repo)}, packages={};
    const exec=(c,a)=>cp.execFileSync(c,a,{encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024}).trim();
    for(const step of repo.installs){
      const cwd=path.join(root,step.cwd), key=step.manager+':'+step.cwd;
      if(step.manager==='npm'){
        const fingerprint=packageFingerprint(cwd);
        packages[key]={fingerprint,list:fingerprint?JSON.parse(fs.readFileSync('${REMOTE}/packages.json')):null};
      }else{
        const candidates=[path.join(cwd,'.venv/bin/python'),path.join(cwd,'venv/bin/python'),path.join(cwd,'env/bin/python'),path.join(root,'.venv/bin/python')];
        const found=candidates.filter(p=>fs.existsSync(p)), python=found[0];
        packages[key]=python?{interpreter:path.relative(root,python),candidates:found.map(p=>path.relative(root,p)),
          version:exec(python,['--version']),freeze:exec(python,['-m','pip','freeze','--all']).split('\\n').filter(Boolean).sort()}
          :{error:'No supported local Python environment found; cannot confirm package equivalence'};
      }
    }
    console.log(JSON.stringify({packages,node:process.version,npm:exec('npm',['--version']),python:exec('python3',['--version']),
      arch:process.arch,platform:process.platform,
      cache:{npm_prefer_offline:exec('npm',['config','get','prefer-offline']),seed_present:fs.existsSync('/home/user/.cache/engelbart/seed.json')},
      manifest_hashes:Object.fromEntries(repo.files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')])),
      install_changes:cp.execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'})}));`;
  const result = await sandbox.commands.run(`node -e ${quote(program)}`, { timeoutMs: 60_000 });
  const collected = JSON.parse(result.stdout);
  const lists = {};
  for (const [key, entry] of Object.entries(collected.packages)) {
    if (entry.list) { lists[key] = entry.list; delete entry.list; }
    if (entry.freeze) {
      lists[key] = entry.freeze;
      entry.fingerprint = pythonFingerprint(entry.freeze);
      delete entry.freeze;
    }
  }
  record.installed = collected;
  record.installed.package_evidence_hash = hash(lists);
  fs.writeFileSync(path.join(directory, 'packages.json'), JSON.stringify(lists, null, 2), { flag: 'wx' });
}

module.exports = { collectArtifacts };
