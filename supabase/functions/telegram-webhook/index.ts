import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "supabase"

serve(async (req) => {
  if (req.method !== 'POST') return new Response("OK", { status: 200 });

  try {
    const body = await req.json();
    console.log("--- MENSAJE RECIBIDO ---");

    const message = body.message;
    if (!message || !message.text) return new Response('ok', { status: 200 });

    const chatId = message.chat.id;
    const text = message.text.trim();

    // LEER NUESTROS SECRETOS PERSONALIZADOS
    const url = Deno.env.get('MI_URL');
    const key = Deno.env.get('MI_LLAVE');
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');

    if (!url || !key) {
      console.error("ERROR CRÍTICO: No se encontraron MI_URL o MI_LLAVE en los secrets.");
      return new Response('error_config', { status: 200 });
    }

    const supabase = createClient(url, key);

    if (text === '/start') {
      await enviarMensaje(chatId, "👋 Es un gusto saludarlo. Soy el asistente de la WebApp Newton Académico.\n\nPor favor, envíeme su **DNI** para vincular su cuenta.", token);
    } else if (/^\d+$/.test(text)) {
      const { data, error } = await supabase
        .from('responsables')
        .update({ telegram_chat_id: chatId.toString() })
        .eq('dni', text)
        .select();

      let resp = "❌ El DNI no figura en el sistema. Contacte al Administrador del Sistema.";
      if (data && data.length > 0) resp = `✅ ¡Hola ${data[0].nombres.split(' ')[0]}! La vinculación de su cuenta se ha realizado de forma exitosa.`;
      
      await enviarMensaje(chatId, resp, token);
    }

    return new Response('ok', { status: 200 });

  } catch (e) {
    console.error("Error:", e.message);
    return new Response('ok', { status: 200 });
  }
})

async function enviarMensaje(chatId: number, text: string, token: string | undefined) {
  if (!token) {
    console.error("ERROR: No se pudo leer el token de las variables de entorno.");
    return;
  }
  
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      chat_id: chatId, 
      text: text, 
      parse_mode: 'Markdown' 
    })
  });

  const resJson = await response.json();
  if (!resJson.ok) {
    console.error("Telegram error:", resJson.description);
  }
}