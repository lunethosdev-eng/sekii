/**
 * Seki API v2.0 — Servidor Express + Supabase + YouTube API v3 + Bot de Nuevos Lanzamientos
 */
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const NodeID3 = require('node-id3');

// Polyfill WebSocket para Node < 22
const ws = require('ws');
if (!globalThis.WebSocket) {
  globalThis.WebSocket = ws.WebSocket || ws;
}

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://esjoifsjljvymttinyhj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
const API_SECRET = process.env.API_SECRET || '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCYxGyZOLyOC9fD5PTTCVuuQ0xM1QTKido';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws.WebSocket || ws }
});

app.use(express.json());

// Middleware con Logging en Terminal para el Cliente
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`\n📥 [REQUEST] ${req.method} ${req.originalUrl} - IP: ${req.ip}`);
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`📤 [RESPONSE] ${req.method} ${req.originalUrl} -> Status: ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Middleware de Autenticación
function auth(req, res, next) {
  if (!API_SECRET) return next();
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_SECRET) {
    console.warn('⚠️ [AUTH] Clave API inválida o no proporcionada.');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Extractor de ID de YouTube
function extractYoutubeId(input) {
  const str = String(input || '').trim();
  if (!str) return null;
  const patterns = [
    /(?:youtube\.com\/(?:watch\?.*?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?.*?v=)([\w-]{11})/i,
    /[?&]v=([\w-]{11})/i,
    /(?:^|[^\w-])([\w-]{11})(?:$|[^\w-])/
  ];
  for (const re of patterns) {
    const m = str.match(re);
    if (m && m[1] && /^[\w-]{11}$/.test(m[1])) return m[1];
  }
  if (/^[\w-]{11}$/.test(str)) return str;
  return null;
}

function cleanTitle(rawTitle) {
  return String(rawTitle || '')
    .replace(/\([\s\S]*?\)/g, '')
    .replace(/\[[\s\S]*?\]/g, '')
    .replace(/\b(ft|feat|featuring)\b.*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- SCRAPER DE ARTISTAS (Foto + Biografía) ---
async function fetchArtistInfo(artistName) {
  console.log(`🔍 [ARTIST SCRAPER] Buscando información e imagen de: "${artistName}"`);
  let imageUrl = null;
  let bio = `Artista musical ${artistName}`;

  try {
    // 1. Obtener imagen HD desde iTunes API
    const itunesRes = await axios.get(
      `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=musicArtist&limit=1`,
      { timeout: 5000 }
    );
    if (itunesRes.data.results?.length) {
      const artistData = itunesRes.data.results[0];
      if (artistData.artistLinkUrl) {
        // Fallback a Deezer para conseguir foto de alta resolución del artista
        const deezerRes = await axios.get(
          `https://api.deezer.com/search/artist?q=${encodeURIComponent(artistName)}`,
          { timeout: 5000 }
        );
        if (deezerRes.data.data?.length) {
          imageUrl = deezerRes.data.data[0].picture_xl || deezerRes.data.data[0].picture_big;
        }
      }
    }

    // 2. Obtener resumen de Biografía desde Wikipedia API
    const wikiRes = await axios.get(
      `https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(artistName)}`,
      { timeout: 5000 }
    );
    if (wikiRes.data && wikiRes.data.extract) {
      bio = wikiRes.data.extract;
    }
  } catch (e) {
    console.warn(`⚠️ [ARTIST SCRAPER] Aviso: ${e.message}`);
  }

  // Si se encontró imagen, guardarla/actualizarla en la tabla "artists" de Supabase
  if (imageUrl) {
    try {
      await supabase.from('artists').upsert({
        name: artistName,
        image_url: imageUrl,
        bio: bio,
        updated_at: new Date().toISOString()
      }, { onConflict: 'name' });
      console.log(`✅ [ARTIST SCRAPER] Artista guardado/actualizado en DB: ${artistName}`);
    } catch (err) {
      console.error(`❌ [ARTIST SCRAPER] Error guardando artista en Supabase:`, err.message);
    }
  }

  return { artistName, imageUrl, bio };
}

// Metadatos de canciones desde iTunes
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
        genre: track.primaryGenreName || 'Pop/Urban',
        year: new Date(track.releaseDate).getFullYear() || new Date().getFullYear(),
        coverUrl: coverHd,
        animatedCoverUrl: coverHd ? coverHd.replace(/\.jpg$/, '.m4v') : null,
        durationMs: track.trackTimeMillis || 180000
      };
    }
  } catch (_) {}
  return {
    isrc: null,
    album: 'Single',
    genre: 'Latin/Urban',
    year: new Date().getFullYear(),
    coverUrl: null,
    animatedCoverUrl: null,
    durationMs: 180000
  };
}

async function ytApiSearch(query, limit = 1) {
  if (!YOUTUBE_API_KEY) {
    console.warn('⚠️ [YouTube API] YOUTUBE_API_KEY no encontrada.');
    return [];
  }
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(query)}&maxResults=${limit}&key=${YOUTUBE_API_KEY}`;
    const res = await axios.get(url, { timeout: 8000 });
    if (res.data.items?.length) {
      return res.data.items.map((item) => ({
        id: item.id.videoId,
        title: item.snippet.title,
        uploader: item.snippet.channelTitle
      }));
    }
  } catch (err) {
    console.error('❌ [YouTube API Search Error]:', err.response?.data?.error?.message || err.message);
  }
  return [];
}

async function getVideoDetails(videoId) {
  if (!YOUTUBE_API_KEY) return null;
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`;
    const res = await axios.get(url, { timeout: 8000 });
    if (res.data.items?.length) {
      const snippet = res.data.items[0].snippet;
      return {
        id: videoId,
        title: snippet.title,
        uploader: snippet.channelTitle
      };
    }
  } catch (err) {
    console.error('❌ [YouTube API VideoDetails Error]:', err.response?.data?.error?.message || err.message);
  }
  return null;
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
      '--no-warnings',
      '--prefer-ffmpeg',
      youtubeUrl
    ];

    if (fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 10) {
      args.push('--cookies', cookiesPath);
    }

    console.log('⚙️ [yt-dlp Executing]:', args.join(' '));
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(`yt-dlp no disponible: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        return resolve(true);
      }
      const tail = (err || out).slice(-500);
      reject(new Error(`yt-dlp falló con código ${code}: ${tail}`));
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
  console.log(`🎬 [Procesando Canción] ID: ${youtubeId} | Título: "${cleanSongTitle}" | Artista: "${artist}"`);

  // Extraer/Guardar también información e imagen del artista
  fetchArtistInfo(artist).catch(() => {});

  const tempMp3 = path.join('/tmp', `seki_${youtubeId}.mp3`);
  const tempCover = path.join('/tmp', `seki_${youtubeId}.jpg`);

  try {
    const { data: byYt } = await supabase
      .from('songs')
      .select('*')
      .eq('youtube_id', youtubeId)
      .maybeSingle();

    if (byYt) {
      console.log(`ℹ️ [DB] Canción ya existe en Supabase: ${cleanSongTitle}`);
      return byYt;
    }

    await downloadAudio(`https://www.youtube.com/watch?v=${youtubeId}`, tempMp3);

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

    NodeID3.write({
      title: cleanSongTitle,
      artist,
      album: meta.album,
      year: String(meta.year),
      image: coverBuffer ? {
        mime: 'image/jpeg',
        type: { id: 3, name: 'front cover' },
        description: 'Cover',
        imageBuffer: coverBuffer
      } : undefined
    }, tempMp3);

    console.log('☁️ [Supabase] Subiendo audio a Storage...');
    const mp3Buffer = fs.readFileSync(tempMp3);
    const { error: uploadAudioErr } = await supabase.storage
      .from('audio')
      .upload(`${youtubeId}.mp3`, mp3Buffer, { contentType: 'audio/mpeg', upsert: true });

    if (uploadAudioErr) {
      console.error('❌ [Supabase Storage Error Audio]:', uploadAudioErr.message);
      throw uploadAudioErr;
    }

    const { data: audioUrlData } = supabase.storage
      .from('audio')
      .getPublicUrl(`${youtubeId}.mp3`);

    let coverPublicUrl = null;
    if (fs.existsSync(tempCover)) {
      const { error: uploadCoverErr } = await supabase.storage
        .from('covers')
        .upload(`${youtubeId}.jpg`, fs.readFileSync(tempCover), {
          contentType: 'image/jpeg',
          upsert: true
        });

      if (!uploadCoverErr) {
        const { data: coverUrlData } = supabase.storage
          .from('covers')
          .getPublicUrl(`${youtubeId}.jpg`);
        coverPublicUrl = coverUrlData.publicUrl;
      }
    }

    const durationSec = meta.durationMs ? Math.round(meta.durationMs / 1000) : 180;
    const newSong = {
      youtube_id: youtubeId,
      isrc: meta.isrc,
      title: cleanSongTitle,
      artist,
      album: meta.album,
      duration_seconds: durationSec,
      audio_url: audioUrlData.publicUrl,
      cover_url: coverPublicUrl,
      animated_cover_url: meta.animatedCoverUrl,
      lyrics_text: `[00:10.00] Letras de ${cleanSongTitle} por ${artist}\n[00:30.00] Sincronización Seki Automática`,
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
      console.error('❌ [Supabase DB Insert Error]:', dbErr.message);
      throw dbErr;
    }

    console.log(`✅ [EXITO] Canción procesada y publicada en DB: ${cleanSongTitle}`);
    return inserted;
  } catch (err) {
    console.error('❌ [processAndUploadSong ERROR]:', err.message || err);
    return null;
  } finally {
    try { if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); } catch (_) {}
    try { if (fs.existsSync(tempCover)) fs.unlinkSync(tempCover); } catch (_) {}
  }
}

// --- BOT AUTOMÁTICO DE DETECCIÓN DE NUEVOS LANZAMIENTOS ---
const TRACKED_ARTISTS = ['Bad Bunny', 'Laufey', 'Grupo Frontera', 'Eve', 'Taylor Swift', 'H.E.R.'];

async function checkForNewReleases() {
  console.log('🤖 [RELEASE BOT] Comprobando si hay nuevas canciones subidas por tus artistas...');
  for (const artist of TRACKED_ARTISTS) {
    try {
      const videos = await ytApiSearch(`${artist} official audio`, 1);
      if (videos.length) {
        const latest = videos[0];
        const { data: existing } = await supabase
          .from('songs')
          .select('id')
          .eq('youtube_id', latest.id)
          .maybeSingle();

        if (!existing) {
          console.log(`🚀 [RELEASE BOT DETECTED] ¡Nueva canción encontrada para ${artist}!: ${latest.title}`);
          const newSong = await processAndUploadSong(latest.id, latest.title, artist);

          // Registrar la notificación en Supabase para que la App Cliente la reciba en tiempo real
          if (newSong) {
            await supabase.from('notifications').insert([{
              artist_name: artist,
              song_id: newSong.id,
              message: `¡${artist} acaba de lanzar un nuevo tema: "${newSong.title}"!`,
              created_at: new Date().toISOString()
            }]);
            console.log(`📲 [NOTIFICATION SENT] Notificación registrada en DB para el cliente.`);
          }
        }
      }
    } catch (e) {
      console.error(`⚠️ [RELEASE BOT ERROR] Falló la verificación de ${artist}:`, e.message);
    }
  }
}

// Ejecutar el bot automáticamente cada 10 minutos
setInterval(checkForNewReleases, 10 * 60 * 1000);

// --- RUTAS API ---

app.get('/', (_req, res) => {
  res.json({ service: 'seki-api', status: 'online', timestamp: new Date().toISOString() });
});

app.get('/health', (_, res) => {
  res.json({ ok: true, node: process.version, uptime: process.uptime() });
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
  console.log(`🔎 [FETCH CLIENT /api/search] Búsqueda recibida: "${query}"`);

  if (!query) return res.status(400).json({ error: 'Parámetro q requerido' });

  try {
    const ytId = extractYoutubeId(query);

    if (ytId) {
      console.log(`🔗 [LINK DETECTED] Procesando ID de YouTube: ${ytId}`);
      const { data: existing } = await supabase
        .from('songs')
        .select('*')
        .eq('youtube_id', ytId)
        .maybeSingle();

      if (existing) {
        console.log(`✅ [FOUND IN DB] Retornando de Supabase ID: ${ytId}`);
        return res.json({ source: 'database', results: [existing] });
      }

      const info = await getVideoDetails(ytId);
      if (!info) {
        return res.status(404).json({ error: 'No se pudo obtener datos del enlace desde la API de YouTube', results: [] });
      }

      const song = await processAndUploadSong(
        ytId,
        info.title || 'Unknown',
        info.uploader || 'Artista'
      );

      if (!song) {
        return res.status(500).json({ error: 'No se pudo procesar el enlace (yt-dlp o storage falló). Revisa logs del servidor.', results: [] });
      }
      return res.json({ source: 'downloaded_on_demand', results: [song] });
    }

    // Búsqueda por Texto
    const { data: existing } = await supabase
      .from('songs')
      .select('*')
      .or(`title.ilike.%${query}%,artist.ilike.%${query}%`)
      .limit(15);

    if (existing?.length) {
      return res.json({ source: 'database', results: existing });
    }

    const videos = await ytApiSearch(query, 1);
    if (!videos.length) {
      return res.status(404).json({ error: 'Sin resultados', results: [] });
    }
    const v = videos[0];
    const song = await processAndUploadSong(v.id, v.title || query, v.uploader || 'Artista');

    if (!song) {
      return res.status(500).json({ error: 'No se pudo procesar (yt-dlp o storage falló). Revisa logs del servidor.', results: [] });
    }
    return res.json({ source: 'downloaded_on_demand', results: [song] });

  } catch (err) {
    console.error('❌ [Search Route Error]:', err.message || err);
    res.status(500).json({ error: err.message, results: [] });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Seki API escuchando en el puerto ${PORT}`);
  // Ejecutar primera pasada del bot tras arrancar
  setTimeout(checkForNewReleases, 5000);
});
