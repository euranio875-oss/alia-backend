

/**
 * Servidor de Atencion Telefonica con IA - Motor Multi-Negocio
 * ---------------------------------------------------------------
 * Este servidor:
 *  1. Recibe la llamada entrante desde Twilio
 *  2. Convierte lo que dice el cliente a texto (Twilio Gather con speech)
 *  3. Envia el texto + el menu del negocio a la IA (Google Gemini, gratis)
 *  4. Convierte la respuesta de la IA a audio y la reproduce en la llamada
 *  5. Guarda un registro (log) de la llamada para el Panel Central
 *
 * Requiere (variables de entorno):
 *   GEMINI_API_KEY=tu_llave_de_google_gemini
 *   PORT=3000
 */

const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const CONFIG_DIR = path.join(__dirname, "config");

function loadBusinessConfig(twilioNumber) {
  const mapPath = path.join(CONFIG_DIR, "number-to-business.json");
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const businessId = map[twilioNumber];
  if (!businessId) throw new Error("No hay negocio configurado para el numero " + twilioNumber);

  const configPath = path.join(CONFIG_DIR, businessId + ".json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return { businessId, config };
}

function logCallEvent(businessId, event) {
  const logPath = path.join(__dirname, "logs", businessId + ".jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(Object.assign({ timestamp: new Date().toISOString() }, event)) + "\n");
}

app.post("/voice/incoming", (req, res) => {
  const calledNumber = req.body.To;
  const { businessId, config } = loadBusinessConfig(calledNumber);

  logCallEvent(businessId, { type: "call_started", callSid: req.body.CallSid, from: req.body.From });

  const twiml = `
    <Response>
      <Gather input="speech" language="es-MX" speechTimeout="auto" action="/voice/process?businessId=${businessId}">
        <Say language="es-MX">${escapeXml(config.saludoInicial)}</Say>
      </Gather>
      <Say>No escuche nada, intentemos de nuevo.</Say>
      <Redirect>/voice/incoming</Redirect>
    </Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/voice/process", async (req, res) => {
  const businessId = req.query.businessId;
  const clienteDijo = req.body.SpeechResult || "";
  const configPath = path.join(CONFIG_DIR, businessId + ".json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  logCallEvent(businessId, { type: "cliente_dijo", callSid: req.body.CallSid, texto: clienteDijo });

  let respuestaIA;
  let debeTransferir = false;
  try {
    const resultado = await consultarIA(clienteDijo, config);
    respuestaIA = resultado.textoParaCliente;
    debeTransferir = resultado.debeTransferir;
  } catch (err) {
    logCallEvent(businessId, { type: "error", callSid: req.body.CallSid, error: err.message });
    respuestaIA = "Disculpa, tuve un problema tecnico. Un momento por favor.";
  }

  logCallEvent(businessId, { type: "ia_respondio", callSid: req.body.CallSid, texto: respuestaIA, transferido: debeTransferir });

  if (debeTransferir && config.telefonoSucursal) {
    const twiml = `
      <Response>
        <Say language="es-MX">${escapeXml(respuestaIA)}</Say>
        <Dial>${config.telefonoSucursal}</Dial>
      </Response>`;
    return res.type("text/xml").send(twiml);
  }

  const twiml = `
    <Response>
      <Gather input="speech" language="es-MX" speechTimeout="auto" action="/voice/process?businessId=${businessId}">
        <Say language="es-MX">${escapeXml(respuestaIA)}</Say>
      </Gather>
      <Say>Gracias por llamar, hasta luego.</Say>
    </Response>`;
  res.type("text/xml").send(twiml);
});

async function consultarIA(textoCliente, config) {
  const systemPrompt = `
Eres Alia, la asistente telefonica de "${config.nombreNegocio}".

QUIEN ERES:
Atiendes este negocio como si fuera tuyo. Tu prioridad no es "contestar
rapido y ya" sino que el cliente cuelgue satisfecho y quiera volver a
llamar. Eres calida, resolutiva y te haces cargo de los problemas, no los
evades.

COMO HABLAS:
Responde SIEMPRE en el mismo idioma en que te habla el cliente.
Se breve, clara y natural, esto es una llamada telefonica, no un chat.
Nunca suenes robotica ni leas el menu completo de corrido; conversa.

Informacion del negocio:
${JSON.stringify(config.menu, null, 2)}

Reglas del negocio:
${config.reglas.join("\n")}

CUANDO TRANSFERIR A UN HUMANO:
Transfiere la llamada con alguien de la sucursal cuando:
- El cliente pide hablar con una persona explicitamente.
- Es una queja o problema que tu no puedes resolver.
- El cliente esta muy molesto y no se calma con tu ayuda.
- Es algo fuera de lo que sabes.

Si decides transferir, responde con una frase breve y calida explicandole
al cliente que lo vas a comunicar con alguien de la sucursal, y agrega al
final, en una linea aparte, exactamente esto: [TRANSFERIR]
No expliques la etiqueta [TRANSFERIR] al cliente, es solo una senal interna.
`.trim();

  const modelo = config.modeloIA || "gemini-2.5-flash";
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + modelo + ":generateContent?key=" + process.env.GEMINI_API_KEY;

  const respuesta = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: textoCliente }] }],
      generationConfig: { maxOutputTokens: 300 },
    }),
  });

  if (!respuesta.ok) {
    const errorTexto = await respuesta.text();
    throw new Error("Gemini API error (" + respuesta.status + "): " + errorTexto);
  }

  const data = await respuesta.json();
  const textoCompleto = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0].text) || "¿Podrias repetir eso, por favor?";

  const debeTransferir = textoCompleto.includes("[TRANSFERIR]");
  const textoParaCliente = textoCompleto.replace("[TRANSFERIR]", "").trim();

  return { textoParaCliente: textoParaCliente, debeTransferir: debeTransferir };
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, function(c) {
    const map = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };
    return map[c];
  });
}

app.get("/api/panel/negocios", (req, res) => {
  const map = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "number-to-business.json"), "utf8"));
  const negocios = Object.values(map).map((businessId) => {
    const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, businessId + ".json"), "utf8"));
    const logPath = path.join(__dirname, "logs", businessId + ".jsonl");
    const llamadas = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
    return { businessId, nombre: config.nombreNegocio, totalEventos: llamadas.length, ultimosEventos: llamadas.slice(-10) };
  });
  res.json(negocios);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto " + PORT));
