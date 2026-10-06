const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const NodeID3 = require('node-id3');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = 'https://esjoifsjljvymttinyhj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzam9pZnNqbGp2eW10dGlueWhqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTAzNjIxMCwiZXhwIjoyMTA2NjEyMjEwfQ.fJvzKJ_VbPh6VcwqfAVr0rmpzsCJBoD-iTl3dUKPPgE';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.static(__dirname));

function cleanTitle(rawTitle) {
  return rawTitle
    .replace(/\([\s\S]*?\)/g, '')
    .replace(/\[[\s\S]*?\]/g, '')
    .replace(/\b(ft|feat|featuring)\b.*/gi, '')
    .trim();
}

async function fetchiTunesMetadata(artist, title) {
  try {
    const query = encodeURIComponent(`${artist} ${cleanTitle(title)}`);
    const res = await axios.get(`https://itunes.apple.com/search?term=${query}&entity=song&limit=1`, { timeout: 4000 });
    if (res.data.results && res.data.results.length > 0) {
      const track = res.data.results[0];
      const coverHd = track.artworkUrl100 ? track.artworkUrl100.replace('100x100bb', '1400x1400bb') : null;
      return {
        isrc: track.isrc || null,
        album: track.collectionName || 'Single',
        genre: track.primaryGenreName || 'Pop/Urban',
        year: new Date(track.releaseDate).getFullYear() || new Date().getFullYear(),
        coverUrl: coverHd,
        animatedCoverUrl: coverHd ? coverHd.replace(/\.jpg$/, '.m4v') : null
      };
    }
  } catch (e) {}
  return { isrc: null, album: 'Single', genre: 'Latin/Urban', year: new Date().getFullYear(), coverUrl: null, animatedCoverUrl: null };
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
      youtubeUrl
    ];
    if (fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }
    const child = spawn('yt-dlp', args);
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`yt-dlp exit status ${code}`));
    });
  });
}

async function processAndUploadSong(youtubeId, rawTitle, defaultArtist) {
  let artist = defaultArtist;
  let title = rawTitle;
  if (rawTitle.includes('-')) {
    const parts = rawTitle.split('-');
    artist = parts[0].trim();
    title = parts.slice(1).join('-').trim();
  }
  const cleanSongTitle = cleanTitle(title);
  const tempMp3 = path.join(__dirname, `temp_${youtubeId}.mp3`);
  const tempCover = path.join(__dirname, `temp_${youtubeId}.jpg`);

  try {
    await downloadAudio(`https://www.youtube.com/watch?v=${youtubeId}`, tempMp3);
    if (!fs.existsSync(tempMp3)) return null;

    const meta = await fetchiTunesMetadata(artist, cleanSongTitle);
    let coverBuffer = null;
    if (meta.coverUrl) {
      try {
        const imgRes = await axios.get(meta.coverUrl, { responseType: 'arraybuffer', timeout: 5000 });
        coverBuffer = Buffer.from(imgRes.data);
        fs.writeFileSync(tempCover, coverBuffer);
      } catch (e) {}
    }

    const tags = {
      title: cleanSongTitle,
      artist: artist,
      album: meta.album,
      year: meta.year.toString(),
      image: coverBuffer ? { mime: "image/jpeg", type: { id: 3, name: "front cover" }, description: "Cover Art", imageBuffer: coverBuffer } : undefined
    };
    NodeID3.write(tags, tempMp3);

    const mp3Buffer = fs.readFileSync(tempMp3);
    await supabase.storage.from('audio').upload(`${youtubeId}.mp3`, mp3Buffer, { contentType: 'audio/mpeg', upsert: true });
    const { data: audioUrlData } = supabase.storage.from('audio').getPublicUrl(`${youtubeId}.mp3`);

    let coverPublicUrl = null;
    if (fs.existsSync(tempCover)) {
      const coverBuf = fs.readFileSync(tempCover);
      await supabase.storage.from('covers').upload(`${youtubeId}.jpg`, coverBuf, { contentType: 'image/jpeg', upsert: true });
      const { data: coverUrlData } = supabase.storage.from('covers').getPublicUrl(`${youtubeId}.jpg`);
      coverPublicUrl = coverUrlData.publicUrl;
    }

    const newSong = {
      youtube_id: youtubeId,
      isrc: meta.isrc,
      title: cleanSongTitle,
      artist: artist,
      album: meta.album,
      duration_seconds: 180,
      audio_url: audioUrlData.publicUrl,
      cover_url: coverPublicUrl,
      animated_cover_url: meta.animatedCoverUrl,
      lyrics_text: `[00:10.00] Letras de ${cleanSongTitle} por ${artist}\n[00:30.00] Sincronización Seki Automática`,
      genre: meta.genre,
      release_year: meta.year,
      source_platform: 'youtube'
    };

    const { data: inserted, error: dbErr } = await supabase.from('songs').insert([newSong]).select().single();
    if (dbErr) throw dbErr;
    return inserted;
  } catch (err) {
    console.error('Error procesando canción On-Demand:', err.message);
    return null;
  } finally {
    if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3);
    if (fs.existsSync(tempCover)) fs.unlinkSync(tempCover);
  }
}

// ENDPOINT DE BÚSQUEDA Y PROCESAMIENTO DINÁMICO (ON-DEMAND)
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Parámetro "q" requerido.' });

  try {
    // 1. Verificar si existe en la base de datos
    const { data: existing } = await supabase
      .from('songs')
      .select('*')
      .or(`title.ilike.%${query}%,artist.ilike.%${query}%`)
      .limit(10);

    if (existing && existing.length > 0) {
      return res.json({ source: 'database', results: existing });
    }

    // 2. Si no existe, descargar en vivo desde YouTube
    console.log(`🔍 Canción no encontrada localmente. Descargando On-Demand: "${query}"...`);
    const cmd = `yt-dlp "ytsearch1:${query}" --dump-json --flat-playlist`;
    const stdout = execSync(cmd).toString().trim();

    if (!stdout) return res.status(404).json({ error: 'No se encontraron resultados en YouTube.' });

    const videoInfo = JSON.parse(stdout);
    const downloadedSong = await processAndUploadSong(videoInfo.id, videoInfo.title || query, videoInfo.uploader || 'Artista Desconocido');

    if (downloadedSong) {
      return res.json({ source: 'downloaded_on_demand', results: [downloadedSong] });
    } else {
      return res.status(500).json({ error: 'Fallo al procesar y subir el archivo.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/songs', async (req, res) => {
  const { data, error } = await supabase.from('songs').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// KEEP-ALIVE BOT (Mantiene Render activo simulando tráfico)
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
  setInterval(() => {
    axios.get(RENDER_EXTERNAL_URL)
      .then(() => console.log('🤖 [Keep-Alive Bot] Ping enviado con éxito a Render.'))
      .catch(e => console.log('⚠️ [Keep-Alive Bot] Error en ping:', e.message));
  }, 10 * 60 * 1000); // Cada 10 minutos
}

app.listen(PORT, () => {
  console.log(`🌐 Servidor Web de Seki activo en el puerto ${PORT}`);
});
