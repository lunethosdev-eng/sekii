const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const NodeID3 = require('node-id3');

const SUPABASE_URL = 'https://esjoifsjljvymttinyhj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzam9pZnNqbGp2eW10dGlueWhqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTAzNjIxMCwiZXhwIjoyMTA2NjEyMjEwfQ.fJvzKJ_VbPh6VcwqfAVr0rmpzsCJBoD-iTl3dUKPPgE';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PRIORITY_ARTISTS = [
  'Laufey',
  'Grupo Frontera',
  'H.E.R.',
  'Eve',
  'Late Night Drive Home',
  'Bad Bunny',
  'Taylor Swift',
  'SZA'
];

const JSON_DIR = '/sdcard/Music_Json';
let jsonVersion = 1;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function cleanTitle(rawTitle) {
  return rawTitle
    // Remueve cualquier texto entre paréntesis () o corchetes [] (e.g. Official Video, With Chords, Lyric Video)
    .replace(/\([\s\S]*?\)/g, '')
    .replace(/\[[\s\S]*?\]/g, '')
    // Remueve referencias a feat / ft
    .replace(/\b(ft|feat|featuring)\b.*/gi, '')
    .trim();
}

async function checkInternetConnection() {
  try {
    await axios.get('https://www.google.com', { timeout: 4000 });
    return true;
  } catch (e) {
    return false;
  }
}

async function isSongInDatabase(youtubeId, artist, title) {
  try {
    const { data: byYt } = await supabase
      .from('songs')
      .select('id')
      .eq('youtube_id', youtubeId)
      .maybeSingle();

    if (byYt) return true;

    const { data: byMetadata } = await supabase
      .from('songs')
      .select('id')
      .ilike('artist', `%${artist}%`)
      .ilike('title', `%${title}%`)
      .maybeSingle();

    return !!byMetadata;
  } catch (err) {
    console.error('⚠️ Error consultando deduplicación:', err.message);
    return false;
  }
}

async function fetchiTunesMetadata(artist, title) {
  try {
    const sanitizedTitle = cleanTitle(title);
    const query = encodeURIComponent(`${artist} ${sanitizedTitle}`);
    const res = await axios.get(`https://itunes.apple.com/search?term=${query}&entity=song&limit=5`);
    
    if (res.data.results && res.data.results.length > 0) {
      // Filtrar para encontrar el resultado que realmente pertenezca al artista buscado
      const matchedTrack = res.data.results.find(t => 
        t.artistName.toLowerCase().includes(artist.toLowerCase()) || 
        artist.toLowerCase().includes(t.artistName.toLowerCase())
      ) || res.data.results[0];

      const coverHd = matchedTrack.artworkUrl100 ? matchedTrack.artworkUrl100.replace('100x100bb', '1400x1400bb') : null;
      return {
        isrc: matchedTrack.isrc || null,
        album: matchedTrack.collectionName || 'Single',
        genre: matchedTrack.primaryGenreName || 'Pop/Urban',
        year: new Date(matchedTrack.releaseDate).getFullYear() || new Date().getFullYear(),
        coverUrl: coverHd,
        animatedCoverUrl: coverHd ? coverHd.replace(/\.jpg$/, '.m4v') : null
      };
    }
  } catch (e) {
    console.log('⚠️ Metadata de iTunes no disponible, usando genérico.');
  }
  return { isrc: null, album: 'Single', genre: 'Latin/Urban', year: new Date().getFullYear(), coverUrl: null, animatedCoverUrl: null };
}

function downloadWithYtDlp(youtubeUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--cookies', path.join(__dirname, 'cookies.txt'),
      '-o', outputPath,
      '--match-filter', 'duration > 60',
      '--no-playlist',
      youtubeUrl
    ];

    const child = spawn('yt-dlp', args);

    child.stdout.on('data', (data) => {
      const output = data.toString();
      const progressMatch = output.match(/\[download\]\s+(\d+\.\d+)%\s+of\s+~?\s*(\d+\.\d+\w+)\s+at\s+(\d+\.\d+\w+\/s)\s+ETA\s+(\d+:\d+)/);
      if (progressMatch) {
        const [, percent, size, speed, eta] = progressMatch;
        process.stdout.write(`\r📡 [SEKI DOWNLOADING] ${percent}% | Tamaño: ${size} | Vel: ${speed} | ETA: ${eta}  `);
      }
    });

    child.on('close', (code) => {
      console.log('\n');
      if (code === 0) resolve(true);
      else reject(new Error(`yt-dlp finalizó con código ${code}`));
    });
  });
}

async function uploadToSupabaseBucket(bucketName, filePath, fileName, contentType) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const { error } = await supabase.storage
      .from(bucketName)
      .upload(fileName, fileBuffer, { contentType, upsert: true });

    if (error) throw error;

    const { data: publicUrlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return publicUrlData.publicUrl;
  } catch (err) {
    console.error(`❌ Error subiendo a ${bucketName}:`, err.message);
    return null;
  }
}

function embedID3Tags(filePath, title, artist, album, year, coverBuffer) {
  const tags = {
    title: title,
    artist: artist,
    album: album,
    year: year.toString(),
    image: coverBuffer ? {
      mime: "image/jpeg",
      type: { id: 3, name: "front cover" },
      description: "Cover Art",
      imageBuffer: coverBuffer
    } : undefined
  };
  NodeID3.write(tags, filePath);
}

async function processTrack(youtubeId, rawTitle, defaultArtist) {
  const url = `https://www.youtube.com/watch?v=${youtubeId}`;
  let artist = defaultArtist;
  let title = rawTitle;

  if (rawTitle.includes('-')) {
    const parts = rawTitle.split('-');
    artist = parts[0].trim();
    title = parts.slice(1).join('-').trim();
  }

  const cleanSongTitle = cleanTitle(title);
  console.log(`\n🎵 Procesando: "${cleanSongTitle}" de ${artist}`);

  const exists = await isSongInDatabase(youtubeId, artist, cleanSongTitle);
  if (exists) {
    console.log(`⏭️ Canción ya existente en Supabase. Omitiendo: ${cleanSongTitle}`);
    return;
  }

  const tempMp3Path = path.join(__dirname, `temp_${youtubeId}.mp3`);
  const tempCoverPath = path.join(__dirname, `temp_${youtubeId}.jpg`);

  try {
    await downloadWithYtDlp(url, tempMp3Path);

    if (!fs.existsSync(tempMp3Path)) {
      console.log('⚠️ El archivo no se generó (posiblemente filtro de duración < 60s).');
      return;
    }

    const meta = await fetchiTunesMetadata(artist, cleanSongTitle);

    let coverBuffer = null;
    if (meta.coverUrl) {
      try {
        const imgRes = await axios.get(meta.coverUrl, { responseType: 'arraybuffer' });
        coverBuffer = Buffer.from(imgRes.data);
        fs.writeFileSync(tempCoverPath, coverBuffer);
      } catch (e) {
        console.log('⚠️ No se pudo descargar la portada HD.');
      }
    }

    embedID3Tags(tempMp3Path, cleanSongTitle, artist, meta.album, meta.year, coverBuffer);

    console.log('☁️ Subiendo recursos a Supabase Storage...');
    const audioPublicUrl = await uploadToSupabaseBucket('audio', tempMp3Path, `${youtubeId}.mp3`, 'audio/mpeg');
    let coverPublicUrl = null;
    if (fs.existsSync(tempCoverPath)) {
      coverPublicUrl = await uploadToSupabaseBucket('covers', tempCoverPath, `${youtubeId}.jpg`, 'image/jpeg');
    }

    if (!audioPublicUrl) throw new Error('Fallo al obtener URL pública del audio.');

    const { error: dbErr } = await supabase.from('songs').insert([{
      youtube_id: youtubeId,
      isrc: meta.isrc,
      title: cleanSongTitle,
      artist: artist,
      album: meta.album,
      duration_seconds: 180,
      audio_url: audioPublicUrl,
      cover_url: coverPublicUrl,
      animated_cover_url: meta.animatedCoverUrl,
      lyrics_text: `[00:10.00] Letras de ${cleanSongTitle} por ${artist}\n[00:30.00] Sincronización Seki Automática`,
      genre: meta.genre,
      release_year: meta.year,
      source_platform: 'youtube'
    }]);

    if (dbErr) throw dbErr;

    console.log(`✅ ¡Canción procesada con éxito y sincronizada!: ${cleanSongTitle}`);

  } catch (error) {
    console.error(`❌ Error procesando track ${youtubeId}:`, error.message);
  } finally {
    if (fs.existsSync(tempMp3Path)) fs.unlinkSync(tempMp3Path);
    if (fs.existsSync(tempCoverPath)) fs.unlinkSync(tempCoverPath);
  }
}

async function searchAndProcessArtist(artistName) {
  console.log(`\n🔍 Buscando catálogo/tendencias de: ${artistName}`);
  try {
    const cmd = `yt-dlp --cookies cookies.txt "ytsearch10:${artistName} audio official" --dump-json --flat-playlist`;
    const stdout = execSync(cmd).toString();
    const lines = stdout.trim().split('\n');

    for (const line of lines) {
      if (!line) continue;
      const video = JSON.parse(line);
      if (video && video.id) {
        await processTrack(video.id, video.title || `${artistName} Track`, artistName);
        await sleep(3000);
      }
    }
  } catch (err) {
    console.error(`⚠️ Error al buscar canciones para ${artistName}:`, err.message);
  }
}

async function exportLocalJson() {
  try {
    const { data: songs, error } = await supabase
      .from('songs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    const payload = {
      version: jsonVersion,
      generated_at: new Date().toISOString(),
      total_tracks: songs.length,
      tracks: songs
    };

    const filePath = path.join(JSON_DIR, `v${jsonVersion}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    console.log(`📁 Exportado JSON Local: ${filePath}`);
    jsonVersion++;
  } catch (err) {
    console.error('❌ Error generando JSON local:', err.message);
  }
}

async function mainLoop() {
  console.log('🤖 BOT SEKI INICIADO Y CORRIENDO EN SEGUNDO PLANO 24/7...');

  try {
    execSync('termux-wake-lock');
    console.log('🔒 Termux Wake Lock Activado');
  } catch (e) {
    console.log('⚠️ No se pudo activar termux-wake-lock automáticamente.');
  }

  let retryDelay = 5000;
  setInterval(exportLocalJson, 150000);

  while (true) {
    const online = await checkInternetConnection();
    if (!online) {
      console.log(`📡 Sin conexión a Internet. Reintentando en ${retryDelay / 1000}s...`);
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 300000);
      continue;
    }

    retryDelay = 5000;

    for (const artist of PRIORITY_ARTISTS) {
      await searchAndProcessArtist(artist);
      await sleep(5000);
    }

    await searchAndProcessArtist('Top Latin Hits 2026');
    await searchAndProcessArtist('Global Billboard Top Songs');

    console.log('💤 Ciclo completado. Esperando 5 minutos...');
    await sleep(300000);
  }
}

mainLoop();
