/**
 * Seki API — fix WebSocket crash en Node 20
 * createClient necesita `ws` o Node 22+
 */
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const NodeID3 = require('node-id3');

// Polyfill WebSocket para @supabase/realtime-js en Node < 22
const ws = require('ws');
if (!globalThis.WebSocket) {
  globalThis.WebSocket = ws.WebSocket || ws;
}

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://esjoifsjljvymttinyhj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
const API_SECRET = process.env.API_SECRET || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws.WebSocket || ws }
});

app.use(express.json());

function auth(req, res, next) {
  if (!API_SECRET) return next();
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function cleanTitle(rawTitle) {
  return String(rawTitle || '')
    .replace(/\([\s\S]*?\)/g, '')
    .replace(/\[[\s\S]*?\]/g, '')
    .replace(/\b(ft|feat|featuring)\b.*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchiTunesMetadata(artist, title) {
  try {
    const query = encodeURIComponent(`${artist} ${cleanTitle(title)}`);
    const res = await axios.get(
      `https://itunes.apple.com/search?term=${query}&entity=song&limit=5`,
      { timeout: 5000 }
    );
    if (res.data.results?.length) {
      const track =
        res.data.results.find(
          (t) =>
            t.artistName?.toLowerCase().includes(artist.toLowerCase()) ||
            artist.toLowerCase().includes(t.artistName?.toLowerCase() || '')
        ) || res.data.results[0];
      const coverHd = track.artworkUrl100
        ? track.artworkUrl100.replace('100x100bb', '1400x1400bb')
        : null;
      return {
        isrc: track.isrc || null,
        album: track.collectionName || 'Single',
        genre: track.primaryGenreName || 'Pop',
        year: new Date(track.releaseDate).getFullYear() || new Date().getFullYear(),
        coverUrl: coverHd,
        durationMs: track.trackTimeMillis || 0
      };
    }
  } catch (_) {}
  return {
    isrc: null,
    album: 'Single',
    genre: 'Pop',
    year: new Date().getFullYear(),
    coverUrl: null,
    durationMs: 0
  };
}

function downloadAudio(youtubeUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const args = [
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', outputPath,
      '--no-playlist',
      '--match-filter', 'duration > 45',
      youtubeUrl
    ];
    if (fs.existsSync(cookiesPath)) args.push('--cookies', cookiesPath);
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`yt-dlp ${code}: ${err.slice(-300)}`));
    });
  });
}

async function processAndUploadSong(youtubeId, rawTitle, defaultArtist) {
  let artist = defaultArtist;
  let title = rawTitle;
  if (rawTitle.includes(' - ')) {
    const parts = rawTitle.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  } else if (rawTitle.includes('-')) {
    const parts = rawTitle.split('-');
    artist = parts[0].trim();
    title = parts.slice(1).join('-').trim();
  }
  const cleanSongTitle = cleanTitle(title);
  const tempMp3 = path.join('/tmp', `seki_${youtubeId}.mp3`);
  const tempCover = path.join('/tmp', `seki_${youtubeId}.jpg`);

  try {
    const { data: byYt } = await supabase
      .from('songs')
      .select('*')
      .eq('youtube_id', youtubeId)
      .maybeSingle();
    if (byYt) return byYt;

    await downloadAudio(`https://www.youtube.com/watch?v=${youtubeId}`, tempMp3);
    if (!fs.existsSync(tempMp3)) return null;

    const meta = await fetchiTunesMetadata(artist, cleanSongTitle);
    let coverBuffer = null;
    if (meta.coverUrl) {
      try {
        const imgRes = await axios.get(meta.coverUrl, {
          responseType: 'arraybuffer',
          timeout: 8000
        });
        coverBuffer = Buffer.from(imgRes.data);
        fs.writeFileSync(tempCover, coverBuffer);
      } catch (_) {}
    }

    NodeID3.write(
      {
        title: cleanSongTitle,
        artist,
        album: meta.album,
        year: String(meta.year),
        image: coverBuffer
          ? {
              mime: 'image/jpeg',
              type: { id: 3, name: 'front cover' },
              description: 'Cover',
              imageBuffer: coverBuffer
            }
          : undefined
      },
      tempMp3
    );

    const mp3Buffer = fs.readFileSync(tempMp3);
    await supabase.storage
      .from('audio')
      .upload(`${youtubeId}.mp3`, mp3Buffer, { contentType: 'audio/mpeg', upsert: true });
    const { data: audioUrlData } = supabase.storage
      .from('audio')
      .getPublicUrl(`${youtubeId}.mp3`);

    let coverPublicUrl = null;
    if (fs.existsSync(tempCover)) {
      await supabase.storage
        .from('covers')
        .upload(`${youtubeId}.jpg`, fs.readFileSync(tempCover), {
          contentType: 'image/jpeg',
          upsert: true
        });
      const { data: coverUrlData } = supabase.storage
        .from('covers')
        .getPublicUrl(`${youtubeId}.jpg`);
      coverPublicUrl = coverUrlData.publicUrl;
    }

    const durationSec = meta.durationMs ? Math.round(meta.durationMs / 1000) : 180;
    const newSong = {
      youtube_id: youtubeId,
      title: cleanSongTitle,
      artist,
      album: meta.album,
      duration_seconds: durationSec,
      duration: durationSec,
      audio_url: audioUrlData.publicUrl,
      cover_url: coverPublicUrl,
      genre: meta.genre,
      release_year: meta.year,
      source_platform: 'youtube'
    };

    const { data: inserted, error: dbErr } = await supabase
      .from('songs')
      .insert([newSong])
      .select()
      .single();
    if (dbErr) {
      const minimal = {
        title: cleanSongTitle,
        artist,
        audio_url: audioUrlData.publicUrl,
        cover_url: coverPublicUrl,
        youtube_id: youtubeId
      };
      const { data: ins2, error: e2 } = await supabase
        .from('songs')
        .insert([minimal])
        .select()
        .single();
      if (e2) throw e2;
      return ins2;
    }
    return inserted;
  } catch (err) {
    console.error('processAndUploadSong:', err.message);
    return null;
  } finally {
    try { if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); } catch (_) {}
    try { if (fs.existsSync(tempCover)) fs.unlinkSync(tempCover); } catch (_) {}
  }
}

function ytSearch(query, limit = 1) {
  const n = Math.min(Math.max(limit, 1), 8);
  const cmd = `yt-dlp "ytsearch${n}:${query.replace(/"/g, '')}" --dump-json --flat-playlist --no-download`;
  const stdout = execSync(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }).toString().trim();
  if (!stdout) return [];
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'seki', node: process.version, ts: Date.now() });
});

app.get('/api/songs', auth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
  const { data, error } = await supabase
    .from('songs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ source: 'database', count: data?.length || 0, results: data || [] });
});

app.get('/api/search', auth, async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Parámetro q requerido' });

  try {
    const { data: existing } = await supabase
      .from('songs')
      .select('*')
      .or(`title.ilike.%${query}%,artist.ilike.%${query}%`)
      .limit(15);

    if (existing?.length) {
      return res.json({ source: 'database', results: existing });
    }

    console.log(`[on-demand] ${query}`);
    const videos = ytSearch(query, 1);
    if (!videos.length) {
      return res.status(404).json({ error: 'Sin resultados', results: [] });
    }
    const v = videos[0];
    const song = await processAndUploadSong(
      v.id,
      v.title || query,
      v.uploader || v.channel || 'Artista'
    );
    if (!song) {
      return res.status(500).json({ error: 'No se pudo procesar', results: [] });
    }
    return res.json({ source: 'downloaded_on_demand', results: [song] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, results: [] });
  }
});

app.post('/api/ingest', auth, async (req, res) => {
  const artist = (req.query.artist || req.body?.artist || '').trim();
  const limit = Math.min(parseInt(req.query.limit || req.body?.limit || '5', 10), 10);
  if (!artist) return res.status(400).json({ error: 'artist requerido' });
  res.json({ status: 'started', artist, limit });
  setImmediate(async () => {
    try {
      const videos = ytSearch(`${artist} official audio`, limit);
      for (const v of videos) {
        await processAndUploadSong(v.id, v.title || artist, artist);
        await new Promise((r) => setTimeout(r, 2500));
      }
      console.log(`[ingest] done ${artist}`);
    } catch (e) {
      console.error('[ingest]', e.message);
    }
  });
});

const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
  setInterval(() => {
    axios.get(RENDER_EXTERNAL_URL + '/health').catch(() => {});
  }, 10 * 60 * 1000);
}

app.listen(PORT, () => {
  console.log(`Seki API :${PORT} node=${process.version}`);
});
