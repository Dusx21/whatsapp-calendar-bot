const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const chrono = require("chrono-node");
const cron = require("node-cron");

const app = express();
app.use(bodyParser.json());

// ===== CONFIG =====
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const CALENDAR_ID = process.env.CALENDAR_ID;

// === Google Auth ===
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
  scopes: ["https://www.googleapis.com/auth/calendar"],
});
const calendar = google.calendar({ version: "v3", auth });

// === WEBHOOK (Verificación con Meta) ===
app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verificado correctamente por Meta");
      return res.status(200).send(challenge);
    } else {
      console.warn("❌ Error: token de verificación incorrecto");
      return res.sendStatus(403);
    }
  } catch (error) {
    console.error("❌ Error al procesar la verificación:", error.message);
    return res.sendStatus(500);
  }
});


// === NORMALIZAR TEXTO ===
function normalizeText(text) {
  const replacements = {
    mama: "mamá",
    papa: "papá",
    nino: "niño",
    nina: "niña",
    kelly: "Kelly",
    jose: "José",
    ana: "Ana",
    maria: "María",
    juan: "Juan",
    reunion: "reunión",
  };
  let corrected = text.toLowerCase();
  for (const [k, v] of Object.entries(replacements)) {
    const regex = new RegExp(`\\b${k}\\b`, "gi");
    corrected = corrected.replace(regex, v);
  }
  return corrected.charAt(0).toUpperCase() + corrected.slice(1);
}

// === RECIBIR MENSAJES ===
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const text = message.text?.body || "";
    const lowerText = text.toLowerCase();

    console.log("📩 Mensaje recibido:", text);

    // === 1️⃣ ELIMINAR CITA ===
    if (lowerText.includes("eliminar") || lowerText.includes("borrar")) {
      const keyword = text.replace(/(eliminar|borrar)/gi, "").trim().toLowerCase();
      const events = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: new Date("2025-01-01").toISOString(),
        timeMax: new Date("2026-01-01").toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const found = events.data.items.find((e) =>
        e.summary.toLowerCase().includes(keyword)
      );

      if (!found) {
        await sendMessage(from, `❌ *No encontré ninguna cita con el nombre:* "${keyword}"`);
      } else {
        await calendar.events.delete({
          calendarId: CALENDAR_ID,
          eventId: found.id,
        });
        await sendMessage(
          from,
          `🗑️ *Cita eliminada correctamente:* "${found.summary}" 🗓️`
        );
      }
      return res.sendStatus(200);
    }

    // === 2️⃣ EDITAR CITA ===
    if (lowerText.includes("editar") || lowerText.includes("cambiar")) {
      const keyword = text.split("al")[0].replace(/(editar|cambiar)/gi, "").trim();
      const newDate = chrono.es.parseDate(text);

      const events = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: new Date("2025-01-01").toISOString(),
        timeMax: new Date("2026-01-01").toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const found = events.data.items.find((e) =>
        e.summary.toLowerCase().includes(keyword.toLowerCase())
      );

      if (!found) {
        await sendMessage(from, `❌ *No encontré ninguna cita con el nombre:* "${keyword}"`);
      } else if (!newDate) {
        await sendMessage(from, `⚠️ *No detecté nueva fecha u hora.*\nEjemplo: _cambiar cita con el doctor al martes a las 9am_`);
      } else {
        const updatedEvent = {
          summary: found.summary,
          start: { dateTime: newDate.toISOString() },
          end: { dateTime: new Date(newDate.getTime() + 60 * 60 * 1000).toISOString() },
        };
        await calendar.events.update({
          calendarId: CALENDAR_ID,
          eventId: found.id,
          requestBody: updatedEvent,
        });
        const newDateString = newDate.toLocaleString("es-PE", {
          dateStyle: "full",
          timeStyle: "short",
        });
        await sendMessage(
          from,
          `✏️ *Cita actualizada correctamente*\n📅 ${found.summary}\n🕒 Nueva fecha: ${newDateString}`
        );
      }
      return res.sendStatus(200);
    }

    // === 3️⃣ CONSULTAR CITAS ===
    if (lowerText.includes("qué tengo") || lowerText.includes("que tengo")) {
      let start, end;
      const now = new Date();

      if (lowerText.includes("mañana")) {
        start = new Date(now);
        start.setDate(now.getDate() + 1);
      } else if (lowerText.includes("semana")) {
        start = new Date(now);
        end = new Date(now);
        end.setDate(now.getDate() + 7);
      } else if (lowerText.includes("hoy")) {
        start = new Date(now);
        end = new Date(now);
      } else {
        const detectedDate = chrono.es.parseDate(text);
        if (detectedDate) {
          start = new Date(detectedDate);
          end = new Date(detectedDate);
        } else {
          await sendMessage(
            from,
            `❌ *No pude entender la fecha que mencionas.*\nEjemplo: _qué tengo el lunes_ o _qué tengo el 10 de noviembre_.`
          );
          return res.sendStatus(200);
        }
      }

      const offset = 5 * 60 * 60000;
      start = new Date(start.getTime() + offset);
      start.setHours(0, 0, 0, 0);
      end = new Date(end || start);
      end = new Date(end.getTime() + offset);
      end.setHours(23, 59, 59, 999);

      const events = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      if (events.data.items.length === 0) {
        await sendMessage(from, `📭 *No tienes citas registradas* para esa fecha.`);
      } else {
        const dayName = start.toLocaleDateString("es-PE", {
          weekday: "long",
          day: "numeric",
          month: "long",
        });
        let response = `📅 *Citas para ${dayName}:*\n\n`;
        events.data.items.forEach((ev, i) => {
          const startTime = new Date(ev.start.dateTime || ev.start.date);
          const hora = startTime.toLocaleTimeString("es-PE", {
            hour: "2-digit",
            minute: "2-digit",
          });
          response += `${i + 1}. 📝 *${ev.summary}* — ${hora}\n`;
        });
        response += `\n✨ *Total:* ${events.data.items.length} citas`;
        await sendMessage(from, response);
      }
      return res.sendStatus(200);
    }

    // === 4️⃣ CREAR NUEVO EVENTO ===
    let parsedDate = null;
    if (lowerText.includes("hoy")) parsedDate = new Date();
    else if (lowerText.includes("mañana")) {
      parsedDate = new Date();
      parsedDate.setDate(parsedDate.getDate() + 1);
    } else {
      const results = chrono.es.parse(text, new Date(), { forwardDate: false });
      if (results.length > 0) parsedDate = results[0].start.date();
    }

    if (!parsedDate) {
      await sendMessage(
        from,
        "❌ *No pude entender la fecha u hora.*\n\nEjemplo: _recordar reunión hoy a las 9am_ 📅"
      );
      return res.sendStatus(200);
    }

    const results = chrono.es.parse(text);
    if (results[0] && !results[0].start.isCertain("hour"))
      parsedDate.setHours(9, 0, 0);

    const now = new Date();
    if (parsedDate < now) parsedDate.setDate(parsedDate.getDate() + 1);

    let eventSummary = text;
    const parsedResults = chrono.es.parse(text, new Date(), { forwardDate: false });
    if (parsedResults.length > 0) {
      const dateText = parsedResults[0].text;
      eventSummary = text.replace(dateText, "").trim();
    }
    eventSummary = eventSummary
      .replace(/\b(el|la|los|las|para|por|de|del|al)\b\s*$/gi, "")
      .replace(/^\s*(el|la|los|las|para|por|de|del|al)\b\s*/gi, "")
      .trim();
    eventSummary = normalizeText(eventSummary);
    if (!eventSummary) eventSummary = "Pendiente";

    const startTime = new Date(parsedDate);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: eventSummary,
        start: { dateTime: startTime.toISOString() },
        end: { dateTime: endTime.toISOString() },
      },
    });
    const dateString = startTime.toLocaleString("es-PE", {
      dateStyle: "full",
      timeStyle: "short",
    });
    await sendMessage(
      from,
      `✅ *Evento agregado correctamente*\n\n📝 *${eventSummary}*\n📅 ${dateString}\n✨ *Guardado en Google Calendar*`
    );
    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.sendStatus(500);
  }
});

// === ENVIAR MENSAJES ===
async function sendMessage(to, body) {
  try {
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: body.replace(/\n/g, "\n").normalize("NFC") },
    };
    const headers = {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json; charset=UTF-8",
    };
    await axios.post(url, payload, { headers });
  } catch (error) {
    console.error("❌ Error al enviar mensaje:", error.response?.data || error.message);
  }
}

// === RUTA RAÍZ (para comprobar que Render está activo) ===
app.get("/", (req, res) => {
  res.status(200).send("🚀 Servidor activo. Webhook WhatsApp Calendar Bot listo ✅");
});

// === INICIAR SERVIDOR ===
const PORT = process.env.PORT || 10000;
// Debug temporal
//app.get("*", (req, res) => {
  //console.log("⚠️ Ruta no encontrada:", req.url);
  //res.status(404).send("Ruta no encontrada: " + req.url);
//});
// === RUTA RAÍZ ===
app.get("/", (req, res) => {
  res.status(200).send("🚀 Servidor activo. Webhook WhatsApp Calendar Bot listo ✅");
});

// ✅ Captura de rutas no encontradas
app.use((req, res) => {
  console.log("⚠️ Ruta no encontrada:", req.url);
  res.status(404).send("Ruta no encontrada: " + req.url);
});

// === INICIAR SERVIDOR ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Servidor corriendo en puerto ${PORT} ✏️🗑️`)
);

app.listen(PORT, () =>
  console.log(`🚀 Servidor con edición y eliminación de citas activado en puerto ${PORT} ✏️🗑️`)
);

// === RECORDATORIOS AUTOMÁTICOS (cada 5 minutos) ===
let notifiedEvents = new Set();
cron.schedule("*/5 * * * *", async () => {
  try {
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 60 * 1000);
    const events = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: later.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    for (const ev of events.data.items || []) {
      const eventId = ev.id;
      if (notifiedEvents.has(eventId)) continue;
      const startTime = new Date(ev.start.dateTime || ev.start.date);
      const diffMinutes = Math.floor((startTime - now) / 60000);
      if (diffMinutes <= 60 && diffMinutes >= 0) {
        const hora = startTime.toLocaleTimeString("es-PE", {
          hour: "2-digit",
          minute: "2-digit",
        });
        const msg = `⏰ *Recordatorio:* Tienes "${ev.summary}" hoy a las ${hora} 🗓️`;
        await sendMessage("51955250357", msg); // Cambia por el número real
        notifiedEvents.add(eventId);
      }
    }
  } catch (err) {
    console.error("❌ Error al revisar recordatorios:", err.message);
  }
});

// === RESUMEN DIARIO AUTOMÁTICO (07:00 a. m. hora Perú) ===
cron.schedule("0 7 * * *", async () => {
  try {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    // Obtener eventos del día
    const events = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    // Si no hay citas
    if (!events.data.items.length) {
      await sendMessage(
        "51955250357", // tu número real (sin el +)
        "🌞 *Buenos días!* Hoy no tienes citas programadas. ☕\nAprovecha el día 💪"
      );
      console.log("🌅 No hay citas para hoy (mensaje enviado)");
      return;
    }

    // Si hay citas, prepara el mensaje
    let msg = "🌞 *Buenos días!* Hoy tienes las siguientes citas:\n\n";
    events.data.items.forEach((ev, i) => {
      const hora = new Date(ev.start.dateTime || ev.start.date).toLocaleTimeString("es-PE", {
        hour: "2-digit",
        minute: "2-digit",
      });
      msg += `${i + 1}. 📝 *${ev.summary}* — ${hora}\n`;
    });

    msg += "\n✨ ¡Que tengas un excelente día! ☀️";

    await sendMessage("51955250357", msg);
    console.log("🌅 Resumen diario enviado correctamente");
  } catch (err) {
    console.error("❌ Error al enviar resumen diario:", err.message);
  }
});
