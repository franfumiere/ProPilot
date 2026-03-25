const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const FROM               = process.env.TWILIO_WHATSAPP_FROM;

async function sendWA(to, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams({ To: `whatsapp:${to}`, From: FROM, Body: body });
  await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
}

function diasDesde(fecha) {
  if (!fecha) return 999;
  return Math.floor((Date.now() - new Date(fecha).getTime()) / 86400000);
}

module.exports = async function handler(req, res) {
  // Only allow GET from Vercel cron
  if (req.method !== 'GET') return res.status(405).end();

  // Current hour in Argentina (UTC-3)
  const horaActual = new Date().getUTCHours() - 3;
  const horaStr = String(horaActual < 0 ? horaActual + 24 : horaActual);

  // Get all brokers with resumen configured for this hour
  const { data: perfiles } = await sb
    .from('perfil_broker')
    .select('user_id, whatsapp, hora_resumen')
    .eq('hora_resumen', horaStr)
    .not('whatsapp', 'is', null);

  if (!perfiles || !perfiles.length) {
    return res.status(200).json({ sent: 0, hora: horaStr });
  }

  let sent = 0;

  for (const perfil of perfiles) {
    try {
      const { data: leads } = await sb
        .from('leads')
        .select('*')
        .eq('user_id', perfil.user_id)
        .not('estado', 'eq', 'Cerrado');

      if (!leads || !leads.length) continue;

      const urgentes = [];
      leads.forEach(l => {
        const dias = diasDesde(l.ultimo_contacto);
        const nombre = l.nombre.split(' ')[0];
        if (l.estado === 'Nuevo' && dias >= 1) {
          urgentes.push({ nombre, motivo: 'Sin primer contacto', dias, tel: l.telefono });
        } else if (dias >= 5 && l.estado !== 'Frio') {
          urgentes.push({ nombre, motivo: `Sin contacto hace ${dias} días`, dias, tel: l.telefono });
        } else if (l.estado === 'Frio' && dias < 3) {
          urgentes.push({ nombre, motivo: 'Lead reactivado 🔥', dias, tel: l.telefono });
        }
      });

      urgentes.sort((a, b) => b.dias - a.dias);
      const top = urgentes.slice(0, 5);

      if (!top.length) {
        await sendWA(perfil.whatsapp, `☀️ *Buenos días!* Todo al día — ningún lead necesita atención urgente hoy.\n\nTotal activos: ${leads.length}`);
      } else {
        let msg = `☀️ *Resumen ProPilot — ${new Date().toLocaleDateString('es-AR')}*\n\nEstos leads necesitan atención hoy:\n\n`;
        top.forEach((l, i) => {
          msg += `${i + 1}. *${l.nombre}* — ${l.motivo}`;
          if (l.tel) msg += `\n   📞 ${l.tel}`;
          msg += '\n\n';
        });
        msg += `Total activos: ${leads.length}\n\npro-pilot-seven.vercel.app`;
        await sendWA(perfil.whatsapp, msg);
      }
      sent++;
    } catch(e) {
      console.error('Error sending to', perfil.whatsapp, e.message);
    }
  }

  res.status(200).json({ sent, hora: horaStr });
};
