/**
 * Servidor de Atención Telefónica con IA — Motor Multi-Negocio
 * ---------------------------------------------------------------
 * Este servidor:
 *  1. Recibe la llamada entrante desde Twilio
 *  2. Convierte lo que dice el cliente a texto (Twilio <Gather> con speech)
 *  3. Detecta el idioma automáticamente
 *  4. Envía el texto + el menú del negocio a Claude (Anthropic API)
 *  5. Convierte la respuesta de Claude a audio y la reproduce en la llamada
 *  6. Guarda un registro (log) de la llamada para el Panel Central
 *
 * Requiere (variables de entorno, en un archivo .env):
 *   ANTHROPIC_API_KEY=tu_llave_de_anthropic
 *   TWILIO_ACCOUNT_SID=tu_sid_de_twilio
 *   TWILIO_AUTH_TOKEN=tu_token_de_twilio
 *   PORT=3000
 */

const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------
// CONFIGURACIÓN MULTI-NEGOCIO
// Cada negocio tiene su propio archivo de menú/reglas en /config
// El "businessId" se identifica por el número de Twilio que recibió la llamada
// ---------------------------------------------------------------
const CONFIG_DIR = path.join(__dirname, "config");

function loadBusinessConfig(twilioNumber) {
  const mapPath = path.join(CONFIG_DIR, "number-to-business.json");
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const businessId = map[twilioNumber];
  if (!businessId) throw new Error(`No hay negocio configurado para el número ${twilioNumber}`);

  const configPath = path.join(CONFIG_DIR, `${businessId}.json`);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return { businessId, config };
}

// ---------------------------------------------------------------
// LOG CENTRAL — cada llamada queda registrada aquí para el Panel Central
// (en producción esto se guarda en la base de datos, ej. Supabase,
// aquí se muestra como archivo simple para que veas la estructura)
// ---------------------------------------------------------------
function logCallEvent(businessId, event) {
  const logPath = path.join(__dirname, "logs", `${businessId}.jsonl`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\n");
}

// ---------------------------------------------------------------
// PASO 1: Twilio llama aquí en cuanto entra la llamada
// ---------------------------------------------------------------
app.post("/voice/incoming", (req, res) => {
  const calledNumber = req.body.To; // número de Twilio que recibió la llamada
  const { businessId, config } = loadBusinessConfig(calledNumber);

  logCallEvent(businessId, { type: "call_started", callSid: req.body.CallSid, from: req.body.From });

  const twiml = `
    <Response>
      <Gather input="speech" language="es-MX" speechTimeout="auto" action="/voice/process?businessId=${businessId}">
        <Say language="es-MX">${escapeXml(config.saludoInicial)}</Say>
      </Gather>
      <Say>No escuché nada, intentemos de nuevo.</Say>
      <Redirect>/voice/incoming</Redirect>
    </Response>`;
  res.type("text/xml").send(twiml);
});

// ---------------------------------------------------------------
// PASO 2: Twilio manda aquí lo que dijo el cliente (ya transcrito)
// ---------------------------------------------------------------
app.post("/voice/process", async (req, res) => {
  const businessId = req.query.businessId;
  const clienteDijo = req.body.SpeechResult || "";
  const configPath = path.join(CONFIG_DIR, `${businessId}.json`);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  logCallEvent(businessId, { type: "cliente_dijo", callSid: req.body.CallSid, texto: clienteDijo });

  let respuestaIA;
  try {
    respuestaIA = await consultarIA(clienteDijo, config);
  } catch (err) {
    logCallEvent(businessId, { type: "error", callSid: req.body.CallSid, error: err.message });
    respuestaIA = "Disculpa, tuve un problema técnico. Un momento por favor.";
  }

  logCallEvent(businessId, { type: "ia_respondio", callSid: req.body.CallSid, texto: respuestaIA });

  const twiml = `
    <Response>
      <Gather input="speech" language="es-MX" speechTimeout="auto" action="/voice/process?businessId=${businessId}">
        <Say language="es-MX">${escapeXml(respuestaIA)}</Say>
      </Gather>
      <Say>Gracias por llamar, hasta luego.</Say>
    </Response>`;
  res.type("text/xml").send(twiml);
});

// ---------------------------------------------------------------
// Consulta a Claude: le pasamos el menú/reglas del negocio como contexto
// ---------------------------------------------------------------
async function consultarIA(textoCliente, config) {
  const systemPrompt = `
Eres el asistente telefónico de "${config.nombreNegocio}".
Responde SIEMPRE en el mismo idioma en que te habla el cliente.
Sé breve, claro y amable — esto es una llamada telefónica, no un chat de texto.

Información del negocio:
${JSON.stringify(config.menu, null, 2)}

Reglas:
${config.reglas.join("\n")}
`.trim();

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: "user", content: textoCliente }],
  });

  return msg.content.find((b) => b.type === "text")?.text || "¿Podrías repetir eso, por favor?";
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[c]));
}

// ---------------------------------------------------------------
// API para el Panel Central — lista de negocios y sus últimas llamadas
// ---------------------------------------------------------------
app.get("/api/panel/negocios", (req, res) => {
  const map = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "number-to-business.json"), "utf8"));
  const negocios = Object.values(map).map((businessId) => {
    const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${businessId}.json`), "utf8"));
    const logPath = path.join(__dirname, "logs", `${businessId}.jsonl`);
    const llamadas = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
    return { businessId, nombre: config.nombreNegocio, totalEventos: llamadas.length, ultimosEventos: llamadas.slice(-10) };
  });
  res.json(negocios);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${
