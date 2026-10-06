const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = 3000;

const SUPABASE_URL = 'https://esjoifsjljvymttinyhj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzam9pZnNqbGp2eW10dGlueWhqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTAzNjIxMCwiZXhwIjoyMTA2NjEyMjEwfQ.fJvzKJ_VbPh6VcwqfAVr0rmpzsCJBoD-iTl3dUKPPgE';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.static(__dirname));

app.get('/api/songs', async (req, res) => {
  const { data, error } = await supabase.from('songs').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`🌐 Servidor Web de Seki activo en http://localhost:${PORT}`);
});
