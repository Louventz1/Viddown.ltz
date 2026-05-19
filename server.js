const express = require('express');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3737;
const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(DOWNLOADS_DIR));

// In-memory job store
const jobs = {};

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/twitter\.com|x\.com/i.test(url)) return 'twitter';
  return 'unknown';
}

app.get('/ping', (req, res) => res.json({ ok: true }));

// GET /api/info
app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const args = ['--dump-json', '--no-playlist', url];
  execFile(YT_DLP, args, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      const msg = stderr || err.message;
      return res.status(400).json({ error: 'Could not fetch video info. Check the URL and try again.', detail: msg.slice(0, 300) });
    }
    try {
      const info = JSON.parse(stdout);
      const platform = detectPlatform(url);

      const formats = (info.formats || [])
        .filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
        .reduce((acc, f) => {
          if (!acc.find(x => x.height === f.height)) acc.push({ height: f.height });
          return acc;
        }, [])
        .sort((a, b) => b.height - a.height);

      const allRes = [
        { height: 2160, label: '4K (2160p)',    value: 'bestvideo[height<=2160]+bestaudio/best[height<=2160]' },
        { height: 1440, label: '2K (1440p)',    value: 'bestvideo[height<=1440]+bestaudio/best[height<=1440]' },
        { height: 1080, label: '1080p Full HD', value: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]' },
        { height: 720,  label: '720p HD',       value: 'bestvideo[height<=720]+bestaudio/best[height<=720]'  },
        { height: 480,  label: '480p',          value: 'bestvideo[height<=480]+bestaudio/best[height<=480]'  },
        { height: 360,  label: '360p',          value: 'bestvideo[height<=360]+bestaudio/best[height<=360]'  },
      ];

      const resolutions = formats.length
        ? allRes.filter(r => formats.some(f => f.height >= r.height))
        : allRes;

      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader || info.channel,
        platform,
        resolutions: resolutions.length ? resolutions : allRes,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

// POST /api/start — start a download job, return a jobId
app.post('/api/start', (req, res) => {
  const { url, format, filename } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const fmt = format || 'bestvideo[height<=2160]+bestaudio/best[height<=2160]';
  const safeName = (filename || `video_${Date.now()}`).replace(/[^a-z0-9_\-\.]/gi, '_').slice(0, 80);
  const outTemplate = path.join(DOWNLOADS_DIR, `${safeName}.%(ext)s`);

  jobs[jobId] = {
    status: 'running',
    percent: '0%',
    speed: '',
    eta: '',
    message: 'Starting download…',
    file: null,
    filename: null,
    error: null,
  };

  const args = [
    '--format', fmt,
    '--merge-output-format', 'mp4',
    '--output', outTemplate,
    '--no-playlist',
    '--newline',
    '--progress-template', '%(progress._percent_str)s|||%(progress.speed)s|||%(progress.eta)s',
    url
  ];

  const proc = spawn(YT_DLP, args);

  proc.stdout.on('data', chunk => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      if (line.includes('|||')) {
        const [pct, spd, eta] = line.split('|||');
        jobs[jobId].percent = (pct || '').trim();
        jobs[jobId].speed   = (spd || '').trim().replace('MiB', 'MB').replace('KiB', 'KB');
        jobs[jobId].eta     = (eta || '').trim();
      } else if (line.includes('Merging') || line.includes('[Merger]')) {
        jobs[jobId].message = 'Merging video + audio…';
      } else if (line.includes('[download]') || line.includes('Destination')) {
        jobs[jobId].message = line.trim().slice(0, 100);
      }
    }
  });

  proc.stderr.on('data', chunk => {
    const line = chunk.toString().trim();
    if (line) jobs[jobId].message = line.slice(0, 120);
  });

  proc.on('close', code => {
    if (code === 0) {
      const files = fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.startsWith(safeName))
        .map(f => ({ name: f, time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);

      if (files.length) {
        jobs[jobId].status   = 'done';
        jobs[jobId].percent  = '100%';
        jobs[jobId].file     = `/downloads/${files[0].name}`;
        jobs[jobId].filename = files[0].name;
      } else {
        jobs[jobId].status = 'error';
        jobs[jobId].error  = 'Download complete but file not found.';
      }
    } else {
      jobs[jobId].status = 'error';
      jobs[jobId].error  = jobs[jobId].message || 'Download failed.';
    }
  });

  res.json({ jobId });
});

// GET /api/status/:jobId — poll job progress
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VidDown server running at http://localhost:${PORT}`);
});


