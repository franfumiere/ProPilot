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

function normalizeTel(tel) {
  return tel ? tel.replace(/\D/g, '') : '';
}

async function getSession(telefono) {
  const { data } = await sb.from('bot_sessions').select('*').eq('telefono', telefono).single();
  return data || null;
}

async function setSession(telefono, userId, estado, contexto) {
  const existing = await getSession(telefono);
  if (existing) {
    await sb.from('bot_sessions').update({ estado, contexto, updated_at: new Date().toISOString() }).eq('telefono', telefono);
  } else {
    await sb.from('bot_sessions').insert([{ telefono, user_id: userId, estado, contexto }]);
  }
}

async function clearSession(telefono) {
  await sb.from('bot_sessions').update({ estado: null, contexto: null, updated_at: new Date().toISOString() }).eq('telefono', telefono);
}

async function getUserByPhone(phone) {
  const normalized = '+' + phone.replace('whatsapp:', '').replace(/\D/g, '');
  const { data } = await sb.from('broker_phones').select('user_id').eq('telefono', normalized).single();
  return data?.user_id || null;
}

async function findLead(userId, query) {
  const { data } = await sb.from('leads').select('*').eq('user_id', userId);
  if (!data) return null;
  const q = normalizeTel(query);
  let lead = data.find(l => q.length > 5 && normalizeTel(l.telefono || '').includes(q));
  if (!lead) lead = data.find(l => l.nombre.toLowerCase().includes(query.toLowerCase()));
  return lead || null;
}

async function getLeadsUrgentes(userId) {
  const { data: leads } = await sb.from('leads').select('*').eq('user_id', userId).not('estado', 'eq', 'Cerrado');
  if (!leads || !leads.length) return { urgentes: [], total: 0 };
  const urgentes = [];
  leads.forEach(l => {
    const dias = diasDesde(l.ultimo_contacto);
    if (l.estado === 'Nuevo' && dias >= 1) urgentes.push({ ...l, motivo: 'Sin primer contacto', dias });
    else if (dias >= 5 && l.estado !== 'Frio') urgentes.push({ ...l, motivo: `Sin contacto hace ${dias} dias`, dias });
    else if (l.estado === 'Frio' && dias < 3) urgentes.push({ ...l, motivo: 'Lead reactivado', dias });
  });
  urgentes.sort((a, b) => b.dias - a.dias);
  return { urgentes: urgentes.slice(0, 5), total: leads.length };
}

async function handleSession(from, tel, rawBody, body, userId, session) {
  const ctx = session.contexto || {};
  const estado = session.estado;

  if (estado === 'nuevo_lead_nombre') {
    await setSession(tel, userId, 'nuevo_lead_tel', { nombre: rawBody });
    await sendWA(from, `Nombre: ${rawBody}\n\nCual es el telefono? (o "saltar")`);
    return;
  }
  if (estado === 'nuevo_lead_tel') {
    const telefono = body === 'saltar' ? null : rawBody;
    await setSession(tel, userId, 'nuevo_lead_busca', { ...ctx, telefono });
    await sendWA(from, `Telefono: ${telefono || 'sin telefono'}\n\nQue esta buscando? (o "saltar")`);
    return;
  }
  if (estado === 'nuevo_lead_busca') {
    const busca = body === 'saltar' ? null : rawBody;
    const { error } = await sb.from('leads').insert([{
      user_id: userId, nombre: ctx.nombre, telefono: ctx.telefono,
      busca, fuente: 'WhatsApp', estado: 'Nuevo', ultimo_contacto: new Date().toISOString()
    }]);
    await clearSession(tel);
    if (error) { await sendWA(from, 'Error al crear el lead.'); return; }
    await sendWA(from, `${ctx.nombre} creado correctamente.\n\npro-pilot-seven.vercel.app`);
    return;
  }

  if (estado === 'editar_lead_buscar') {
    const lead = await findLead(userId, rawBody);
    if (!lead) { await sendWA(from, `No encontre "${rawBody}". Intenta de nuevo o escribe cancelar.`); return; }
    await setSession(tel, userId, 'editar_lead_campo', { leadId: lead.id, leadNombre: lead.nombre });
    await sendWA(from, `${lead.nombre}\n\nQue queres editar?\n\n1. Nombre\n2. Telefono\n3. Que busca\n4. Estado\n5. Notas\n6. Cumpleanos`);
    return;
  }
  if (estado === 'editar_lead_campo') {
    const campos = { '1': 'nombre', '2': 'telefono', '3': 'busca', '4': 'estado', '5': 'notas', '6': 'birthday' };
    const labels = { '1': 'Nombre', '2': 'Telefono', '3': 'Que busca', '4': 'Estado', '5': 'Notas', '6': 'Cumpleanos (AAAA-MM-DD)' };
    const campo = campos[body];
    if (!campo) { await sendWA(from, 'Escribe un numero del 1 al 6.'); return; }
    if (campo === 'estado') {
      await setSession(tel, userId, 'editar_lead_valor', { ...ctx, campo });
      await sendWA(from, `Nuevo estado:\n\n1. Nuevo\n2. Contactado\n3. Interesado\n4. Visita\n5. Propuesta\n6. Cerrado\n7. Frio`);
      return;
    }
    await setSession(tel, userId, 'editar_lead_valor', { ...ctx, campo });
    await sendWA(from, `Cual es el nuevo valor para ${labels[body]}?`);
    return;
  }
  if (estado === 'editar_lead_valor') {
    const estados = { '1': 'Nuevo', '2': 'Contactado', '3': 'Interesado', '4': 'Visita', '5': 'Propuesta', '6': 'Cerrado', '7': 'Frio' };
    let valor = ctx.campo === 'estado' ? (estados[body] || rawBody) : rawBody;
    await sb.from('leads').update({ [ctx.campo]: valor }).eq('id', ctx.leadId);
    await clearSession(tel);
    await sendWA(from, `${ctx.leadNombre} actualizado.\n${ctx.campo}: ${valor}`);
    return;
  }

  if (estado === 'registrar_buscar') {
    const lead = await findLead(userId, rawBody);
    if (!lead) { await sendWA(from, `No encontre "${rawBody}". Intenta de nuevo o escribe cancelar.`); return; }
    await setSession(tel, userId, 'registrar_tipo', { leadId: lead.id, leadNombre: lead.nombre });
    await sendWA(from, `${lead.nombre}\n\nQue tipo de contacto?\n\n1. Llamada\n2. WhatsApp\n3. Visita\n4. Cafe\n5. Email\n6. Otro`);
    return;
  }
  if (estado === 'registrar_tipo') {
    const tipos = { '1': 'llamada', '2': 'whatsapp', '3': 'visita', '4': 'cafe', '5': 'email', '6': 'otro' };
    const tipo = tipos[body] || rawBody;
    await setSession(tel, userId, 'registrar_notas', { ...ctx, tipo });
    await sendWA(from, `Queres agregar alguna nota? (o "saltar")`);
    return;
  }
  if (estado === 'registrar_notas') {
    const notas = body === 'saltar' ? null : rawBody;
    await sb.from('contactos').insert([{ lead_id: ctx.leadId, user_id: userId, tipo: ctx.tipo, notas }]);
    await sb.from('leads').update({ ultimo_contacto: new Date().toISOString() }).eq('id', ctx.leadId);
    await clearSession(tel);
    await sendWA(from, `Contacto registrado para ${ctx.leadNombre}.\nTipo: ${ctx.tipo}${notas ? '\nNota: ' + notas : ''}`);
    return;
  }

  if (estado === 'cambiar_estado') {
    const estados = { '1': 'Nuevo', '2': 'Contactado', '3': 'Interesado', '4': 'Visita', '5': 'Propuesta', '6': 'Cerrado', '7': 'Frio' };
    const nuevoEstado = estados[body] || rawBody;
    await sb.from('leads').update({ estado: nuevoEstado }).eq('id', ctx.leadId);
    await clearSession(tel);
    await sendWA(from, `${ctx.leadNombre} — Estado actualizado a ${nuevoEstado}`);
    return;
  }

  if (estado === 'resolver_recordatorio') {
    const idx = parseInt(body) - 1;
    if (isNaN(idx) || idx < 0 || idx >= (ctx.recs || []).length) {
      await sendWA(from, `Escribe un numero valido o cancelar.`);
      return;
    }
    await sb.from('recordatorios').update({ resuelto: true }).eq('id', ctx.recs[idx]);
    await clearSession(tel);
    await sendWA(from, `Recordatorio resuelto.`);
    return;
  }

  if (estado === 'nueva_prop_url') {
    await setSession(tel, userId, 'nueva_prop_tipo', { url: rawBody });
    await sendWA(from, `Que tipo de propiedad?\n\n1. Departamento\n2. Casa\n3. PH\n4. Local\n5. Terreno`);
    return;
  }
  if (estado === 'nueva_prop_tipo') {
    const tipos = { '1': 'Departamento', '2': 'Casa', '3': 'PH', '4': 'Local', '5': 'Terreno' };
    const tipo = tipos[body] || rawBody;
    await setSession(tel, userId, 'nueva_prop_barrio', { ...ctx, tipo });
    await sendWA(from, `Barrio o zona?`);
    return;
  }
  if (estado === 'nueva_prop_barrio') {
    await setSession(tel, userId, 'nueva_prop_precio', { ...ctx, barrio: rawBody });
    await sendWA(from, `Precio? (ej: USD 150.000 o "saltar")`);
    return;
  }
  if (estado === 'nueva_prop_precio') {
    const precio = body === 'saltar' ? null : rawBody;
    await setSession(tel, userId, 'nueva_prop_desc', { ...ctx, precio });
    await sendWA(from, `Descripcion breve? (o "saltar")`);
    return;
  }
  if (estado === 'nueva_prop_desc') {
    const desc = body === 'saltar' ? null : rawBody;
    const { error } = await sb.from('propiedades').insert([{
      user_id: userId, url: ctx.url || null,
      tipo: ctx.tipo, barrio: ctx.barrio, precio: ctx.precio,
      descripcion: desc, estado: 'Activa'
    }]);
    await clearSession(tel);
    if (error) { await sendWA(from, 'Error al guardar la propiedad.'); return; }
    await sendWA(from, `Propiedad guardada.\n${ctx.tipo} en ${ctx.barrio}${ctx.precio ? ' - ' + ctx.precio : ''}\n\npro-pilot-seven.vercel.app`);
    return;
  }

  await clearSession(tel);
  await sendWA(from, `No entendi. Escribe ayuda para ver los comandos.`);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const from    = req.body?.From || '';
  const rawBody = (req.body?.Body || '').trim();
  const body    = rawBody.toLowerCase();
  const tel     = '+' + from.replace('whatsapp:', '').replace(/\D/g, '');

  const userId = await getUserByPhone(from);
  if (!userId) {
    await sendWA(from, 'Tu numero no esta registrado en ProPilot.\nEntra a pro-pilot-seven.vercel.app para crear tu cuenta y configurar tu WhatsApp en Ajustes.');
    return res.status(200).end();
  }

  const session = await getSession(tel);

  if (body === 'cancelar' || body === 'cancel') {
    await clearSession(tel);
    await sendWA(from, 'Operacion cancelada.');
    return res.status(200).end();
  }

  if (session?.estado) {
    await handleSession(from, tel, rawBody, body, userId, session);
    return res.status(200).end();
  }

  if (body.includes('leads de hoy') || body === 'hoy' || body === 'urgentes') {
    const { urgentes, total } = await getLeadsUrgentes(userId);
    if (!urgentes.length) {
      await sendWA(from, `Todo al dia. Tenes ${total} leads activos y ninguno necesita atencion urgente.\n\npro-pilot-seven.vercel.app`);
      return res.status(200).end();
    }
    let msg = `ProPilot - Leads que necesitan atencion\n\n`;
    urgentes.forEach((l, i) => {
      msg += `${i + 1}. ${l.nombre} - ${l.motivo}`;
      if (l.telefono) msg += `\n   ${l.telefono}`;
      msg += '\n\n';
    });
    msg += `Total activos: ${total}\n\npro-pilot-seven.vercel.app`;
    await sendWA(from, msg);
    return res.status(200).end();
  }

  if (body.startsWith('nuevo lead') || body === 'nuevo lead') {
    await setSession(tel, userId, 'nuevo_lead_nombre', {});
    await sendWA(from, 'Nuevo lead\n\nCual es el nombre completo?\n\n(escribe cancelar para salir)');
    return res.status(200).end();
  }

  if (body.startsWith('ver ') || body.startsWith('lead ')) {
    const query = rawBody.replace(/^(ver|lead)\s+/i, '').trim();
    const lead = await findLead(userId, query);
    if (!lead) { await sendWA(from, `No encontre ningun lead con "${query}".`); return res.status(200).end(); }
    const dias = diasDesde(lead.ultimo_contacto);
    let msg = `${lead.nombre}\nEstado: ${lead.estado}\n`;
    if (lead.telefono) msg += `Tel: ${lead.telefono}\n`;
    if (lead.busca) msg += `Busca: ${lead.busca}\n`;
    msg += `Ultimo contacto: hace ${dias} dia${dias !== 1 ? 's' : ''}`;
    await sendWA(from, msg);
    return res.status(200).end();
  }

  if (body.startsWith('editar')) {
    const query = rawBody.replace(/^editar\s*(lead\s*)?/i, '').trim();
    if (!query) {
      await setSession(tel, userId, 'editar_lead_buscar', {});
      await sendWA(from, 'Cual es el nombre o telefono del lead a editar?');
      return res.status(200).end();
    }
    const lead = await findLead(userId, query);
    if (!lead) { await sendWA(from, `No encontre "${query}".`); return res.status(200).end(); }
    await setSession(tel, userId, 'editar_lead_campo', { leadId: lead.id, leadNombre: lead.nombre });
    await sendWA(from, `${lead.nombre}\n\nQue queres editar?\n\n1. Nombre\n2. Telefono\n3. Que busca\n4. Estado\n5. Notas\n6. Cumpleanos`);
    return res.status(200).end();
  }

  if (body.startsWith('registrar') || body.startsWith('contacto ')) {
    const query = rawBody.replace(/^(registrar|contacto)\s+/i, '').trim();
    if (!query) {
      await setSession(tel, userId, 'registrar_buscar', {});
      await sendWA(from, 'Con cual lead queres registrar un contacto? (nombre o telefono)');
      return res.status(200).end();
    }
    const lead = await findLead(userId, query);
    if (!lead) { await sendWA(from, `No encontre "${query}".`); return res.status(200).end(); }
    await setSession(tel, userId, 'registrar_tipo', { leadId: lead.id, leadNombre: lead.nombre });
    await sendWA(from, `${lead.nombre}\n\nQue tipo de contacto?\n\n1. Llamada\n2. WhatsApp\n3. Visita\n4. Cafe\n5. Email\n6. Otro`);
    return res.status(200).end();
  }

  if (body.startsWith('estado ')) {
    const query = rawBody.replace(/^estado\s+/i, '').trim();
    const lead = await findLead(userId, query);
    if (!lead) { await sendWA(from, `No encontre "${query}".`); return res.status(200).end(); }
    await setSession(tel, userId, 'cambiar_estado', { leadId: lead.id, leadNombre: lead.nombre });
    await sendWA(from, `${lead.nombre} - Estado actual: ${lead.estado}\n\nNuevo estado?\n\n1. Nuevo\n2. Contactado\n3. Interesado\n4. Visita\n5. Propuesta\n6. Cerrado\n7. Frio`);
    return res.status(200).end();
  }

  if (body.includes('recordatorio') || body === 'recs') {
    const { data: recs } = await sb.from('recordatorios')
      .select('*, leads(nombre)')
      .eq('user_id', userId).eq('resuelto', false)
      .order('created_at', { ascending: false }).limit(8);
    if (!recs || !recs.length) { await sendWA(from, 'No tenes recordatorios pendientes.'); return res.status(200).end(); }
    let msg = `Recordatorios pendientes\n\n`;
    recs.forEach((r, i) => { msg += `${i + 1}. ${r.leads?.nombre || 'Lead'} - ${r.mensaje || r.tipo}\n`; });
    msg += `\nEscribe el numero para marcar como resuelto.`;
    await setSession(tel, userId, 'resolver_recordatorio', { recs: recs.map(r => r.id) });
    await sendWA(from, msg);
    return res.status(200).end();
  }

  if (body.startsWith('nueva propiedad') || body === 'nueva propiedad') {
    await setSession(tel, userId, 'nueva_prop_url', {});
    await sendWA(from, 'Nueva propiedad\n\nPega la URL de Argenprop o ZonaProp (o escribe los datos manualmente):');
    return res.status(200).end();
  }

  const help = `ProPilot Bot\n\nComandos:\n\n- leads de hoy\n- nuevo lead\n- ver [nombre o tel]\n- editar [nombre o tel]\n- registrar [nombre o tel]\n- estado [nombre o tel]\n- recordatorios\n- nueva propiedad\n\nEscribe cancelar para salir de cualquier flujo.`;
  await sendWA(from, help);
  res.status(200).end();
};
