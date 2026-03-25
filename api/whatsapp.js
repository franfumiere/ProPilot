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
  const params = new URLSearchParams({ To: to, From: FROM, Body: body });
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

async function getLeadsResumen(userId) {
  const { data: leads } = await sb
    .from('leads')
    .select('*')
    .eq('user_id', userId)
    .not('estado', 'eq', 'Cerrado');

  if (!leads || !leads.length) return null;

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
  return { urgentes: urgentes.slice(0, 5), total: leads.length };
}

async function getUserByPhone(phone) {
  // phone comes as whatsapp:+5491151462903 → normalize to +5491151462903
  const normalized = phone.replace('whatsapp:', '');
  const { data } = await sb
    .from('broker_phones')
    .select('user_id')
    .eq('telefono', normalized)
    .single();
  return data?.user_id || null;
}

async function crearLead(userId, texto) {
  // Parse: "nuevo lead: Nombre, telefono, busca"
  const partes = texto.replace(/nuevo lead[:\s]*/i, '').split(',').map(s => s.trim());
  const nombre   = partes[0] || 'Sin nombre';
  const telefono = partes[1] || null;
  const busca    = partes[2] || null;

  const { error } = await sb.from('leads').insert([{
    user_id: userId,
    nombre,
    telefono,
    busca,
    fuente: 'WhatsApp',
    estado: 'Nuevo',
    ultimo_contacto: new Date().toISOString()
  }]);

  return !error ? `✅ Lead *${nombre}* creado correctamente.` : '❌ No pude crear el lead. Revisá el formato.';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const from = req.body?.From || '';
  const body = (req.body?.Body || '').trim().toLowerCase();

  // Find user by phone
  const userId = await getUserByPhone(from);

  if (!userId) {
    await sendWA(from, '❌ Tu número no está registrado en ProPilot. Entrá a pro-pilot-seven.vercel.app para crear tu cuenta.');
    return res.status(200).end();
  }

  // Commands
  if (body.includes('hoy') || body.includes('seguimiento') || body.includes('leads')) {
    const resumen = await getLeadsResumen(userId);
    if (!resumen) {
      await sendWA(from, '✅ No tenés leads activos por ahora.');
      return res.status(200).end();
    }
    if (!resumen.urgentes.length) {
      await sendWA(from, `✅ Todo al día. Tenés ${resumen.total} leads activos y ninguno necesita atención urgente.`);
      return res.status(200).end();
    }
    let msg = `🤖 *ProPilot — Leads que necesitan atención*\n\n`;
    resumen.urgentes.forEach((l, i) => {
      msg += `${i + 1}. *${l.nombre}* — ${l.motivo}`;
      if (l.tel) msg += `\n   📞 ${l.tel}`;
      msg += '\n\n';
    });
    msg += `Total leads activos: ${resumen.total}\n\nVer todo en: pro-pilot-seven.vercel.app`;
    await sendWA(from, msg);
    return res.status(200).end();
  }

  if (body.startsWith('nuevo lead')) {
    const respuesta = await crearLead(userId, req.body?.Body || '');
    await sendWA(from, respuesta);
    return res.status(200).end();
  }

  // Help / default
  const help = `👋 Hola! Soy el asistente de *ProPilot*.\n\nPodés escribirme:\n\n• *leads de hoy* — ver qué leads necesitan atención\n• *nuevo lead: Nombre, Teléfono, Qué busca* — cargar un lead nuevo\n\nO entrá a pro-pilot-seven.vercel.app para ver todo.`;
  await sendWA(from, help);
  res.status(200).end();
};
