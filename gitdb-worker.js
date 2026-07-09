// Git-DB Cloudflare Worker – GitHub JSON DB Proxy
// Deploy: wrangler publish
// Env secrets (wrangler secret put):
//   GITHUB_TOKEN  -> ghp_... (repo:contents write, NEVER exposed to client)
//   GITHUB_OWNER  -> animeshdindapersonal-jpg
//   GITHUB_REPO   -> git-db
//   GITHUB_BRANCH -> main
//   ALLOW_ORIGIN  -> *
// Free: 100,000 req/day, 300+ edge locations worldwide

export default {
  async fetch(request, env, ctx) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\//,'');
    
    const GH = {
      owner: env.GITHUB_OWNER || 'animeshdindapersonal-jpg',
      repo:  env.GITHUB_REPO  || 'git-db',
      branch: env.GITHUB_BRANCH || 'main',
      token: env.GITHUB_TOKEN
    };

    const json = (obj, status=200) => new Response(JSON.stringify(obj), {
      status, headers: { 'Content-Type':'application/json', ...cors }
    });

    // utf8 safe base64
    const toB64 = str => btoa(unescape(encodeURIComponent(str)));

    try {
      // -------- READ (fast, but via worker to avoid CORS/raw cache issues, still unlimited)
      // GET /api/profile/:username
      if (request.method === 'GET' && path.startsWith('profile/')) {
        const username = decodeURIComponent(path.split('/')[1]||'').toLowerCase();
        if(!username) return json({error:'username required'},400);
        // Try raw.githubusercontent first (fast, no rate limit)
        const rawUrl = `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}/profiles/${username}.json`;
        const r = await fetch(rawUrl, { cf: { cacheTtl: 15, cacheEverything: true } });
        if(!r.ok) return json({error:'not_found'},404);
        const profile = await r.json();
        // strip password before sending to public? keep for login check server-side if you want
        return json({ ok:true, profile });
      }

      // -------- LOGIN
      // POST /api/login  {username, password}
      if (request.method === 'POST' && path === 'login') {
        const {username, password} = await request.json();
        const u = (username||'').toLowerCase();
        const rawUrl = `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}/profiles/${u}.json`;
        const r = await fetch(rawUrl, { cf:{cacheTtl:5} });
        if(!r.ok) return json({error:'invalid_credentials'},401);
        const p = await r.json();
        if(p.password !== password) return json({error:'invalid_credentials'},401);
        // never return password to client
        const {password:_pw, ...safe} = p;
        return json({ok:true, profile: safe, session_user: u});
      }

      // Helper: get file sha
      async function getSha(username){
        const apiUrl = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/profiles/${username}.json?ref=${GH.branch}`;
        const r = await fetch(apiUrl, { headers:{ 'User-Agent':'git-db-worker', 'Authorization': `token ${GH.token}`, 'Accept':'application/vnd.github+json' }});
        if(r.status===404) return null;
        if(!r.ok) throw new Error('gh_meta_'+r.status);
        const j = await r.json();
        return j.sha;
      }

      // -------- SIGNUP
      // POST /api/signup  {username, name, email, password, bio, location, website, avatar}
      if (request.method === 'POST' && path === 'signup') {
        const body = await request.json();
        const username = (body.username||'').toLowerCase();
        if(!/^[a-z0-9_-]{3,20}$/.test(username)) return json({error:'invalid_username'},400);
        if(!body.name || !body.password || body.password.length < 4) return json({error:'invalid_input'},400);

        // check exists via GitHub API (not raw CDN — too much cache lag)
        const existsUrl = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/profiles/${encodeURIComponent(username)}.json?ref=${GH.branch}`;
        const existsRes = await fetch(existsUrl, {
          headers:{ 'User-Agent':'git-db-worker', 'Authorization': `token ${GH.token}`, 'Accept':'application/vnd.github+json' }
        });
        if(existsRes.status === 200) return json({error:'username_taken'},409);

        const now = new Date().toISOString();
        const profile = {
          username,
          name: body.name,
          email: body.email||'',
          bio: body.bio||'',
          password: body.password, // NOTE: hash in production! demo only
          avatar: body.avatar || `https://i.pravatar.cc/200?u=${encodeURIComponent(username)}`,
          location: body.location||'',
          website: body.website||'',
          joined: now,
          updated: now,
          gitdb_version: 2
        };

        const putUrl = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/profiles/${username}.json`;
        const putRes = await fetch(putUrl, {
          method:'PUT',
          headers:{
            'Authorization': `token ${GH.token}`,
            'User-Agent':'git-db-worker',
            'Accept':'application/vnd.github+json',
            'Content-Type':'application/json'
          },
          body: JSON.stringify({
            message: `feat(profile): create ${username} via Git-DB Worker`,
            content: toB64(JSON.stringify(profile, null, 2)),
            branch: GH.branch
          })
        });
        if(!putRes.ok){
          const err = await putRes.text();
          return json({error:'github_write_failed', detail: err.slice(0,300)}, 500);
        }
        const {password:_, ...safe} = profile;
        return json({ok:true, profile: safe});
      }

      // -------- UPDATE PROFILE
      // PUT /api/profile/:username  { ...fields, _password_check? }
      if (request.method === 'PUT' && path.startsWith('profile/')) {
        const username = decodeURIComponent(path.split('/')[1]||'').toLowerCase();
        const updates = await request.json();
        // get current
        const sha = await getFileMetaSha();
        async function getFileMetaSha(){
          const s = await getSha(username);
          if(!s) throw new Error('not_found');
          return s;
        }
        // fetch current profile to merge
        const raw = await fetch(`https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}/profiles/${username}.json`);
        const current = raw.ok ? await raw.json() : {};
        const merged = {...current, ...updates, username, updated: new Date().toISOString()};
        const putUrl = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/profiles/${username}.json`;
        const putRes = await fetch(putUrl, {
          method:'PUT',
          headers:{
            'Authorization': `token ${GH.token}`,
            'User-Agent':'git-db-worker',
            'Accept':'application/vnd.github+json',
            'Content-Type':'application/json'
          },
          body: JSON.stringify({
            message: `chore(profile): update ${username} via Git-DB Worker`,
            content: toB64(JSON.stringify(merged, null, 2)),
            branch: GH.branch,
            sha: await getSha(username)
          })
        });
        if(!putRes.ok) return json({error:'update_failed', status: putRes.status}, 500);
        const {password:_, ...safe} = merged;
        return json({ok:true, profile: safe});
      }

      // -------- LIST (optional, for explore)
      // GET /api/list
      if (request.method === 'GET' && path === 'list') {
        // GitHub tree API – cheap
        const apiUrl = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/profiles?ref=${GH.branch}`;
        const r = await fetch(apiUrl, { headers:{ 'User-Agent':'git-db-worker', 'Authorization': `token ${GH.token}` }, cf:{cacheTtl:60} });
        const files = await r.json();
        const users = (Array.isArray(files)?files:[]).filter(f=>f.name.endsWith('.json') && f.name!=='.gitkeep').map(f=>f.name.replace('.json',''));
        return json({ok:true, users, count: users.length});
      }

      return json({error:'not_found', hint:'POST /api/signup  POST /api/login  GET /api/profile/:u  PUT /api/profile/:u'},404);

    } catch (err) {
      return json({error:'worker_exception', message: String(err?.message||err)}, 500);
    }
  }
}
