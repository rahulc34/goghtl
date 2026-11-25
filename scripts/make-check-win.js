// Makes a LOCAL Windows-only copy of harness/check.js whose killInstance really kills the server.
const fs = require('fs');
const [src, dst] = process.argv.slice(2);
let s = fs.readFileSync(src, 'utf8');
const from = "process.kill(-inst.child.pid, 'SIGKILL'); // the whole process group, no warning";
if (!s.includes(from)) throw new Error('patch point not found');
const to = `{ // WINDOWS PATCH (local only): hard-kill the tree and whatever listens on this port
      const cp = require('child_process');
      cp.spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F']);
      const out = cp.spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
      for (const line of out.split(String.fromCharCode(10))) {
        const m = line.trim().split(' ').filter(Boolean);
        if (m[3] === 'LISTENING' && m[1].endsWith(':' + inst.port)) cp.spawnSync('taskkill', ['/PID', m[4], '/F']);
      }
    }`;
fs.writeFileSync(dst, s.replace(from, to));
