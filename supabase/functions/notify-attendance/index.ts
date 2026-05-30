import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from "supabase"

serve(async (req) => {
  const { record } = await req.json() // Fila de la tabla 'asistencia'

  const url = Deno.env.get('MI_URL') ?? ""
  const key = Deno.env.get('MI_LLAVE') ?? ""
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ""
  const supabase = createClient(url, key)

  try {
    console.log("Procesando asistencia para auth_id:", record.user_auth_id);

    // 1. Obtener el DNI del estudiante desde la tabla 'usuarios'
    const { data: userData, error: userError } = await supabase
      .from('usuarios')
      .select('usuario, nombre_completo')
      .eq('auth_id', record.user_auth_id)
      .single();

    if (userError || !userData) {
      console.error("No se encontró el usuario en la tabla 'usuarios'");
      return new Response('Error: Usuario no encontrado', { status: 200 });
    }

    const dniEstudiante = userData.usuario;
    const nombreEstudiante = userData.nombre_completo.toUpperCase();

    // 2. Obtener el id_est de la tabla 'estudiantes' usando el DNI
    const { data: studentData, error: studentError } = await supabase
      .from('estudiantes')
      .select('id_est')
      .eq('dni', dniEstudiante)
      .single();

    if (studentError || !studentData) {
      console.error("No se encontró el estudiante con DNI:", dniEstudiante);
      return new Response('Error: Estudiante no encontrado', { status: 200 });
    }

    // 3. Buscar los responsables vinculados en 'estudiantes_responsables'
    const { data: relData, error: relError } = await supabase
      .from('estudiantes_responsables')
      .select('id_res')
      .eq('id_est', studentData.id_est);

    if (relError || !relData || relData.length === 0) {
      console.error("No hay responsables vinculados para el id_est:", studentData.id_est);
      return new Response('Error: Sin responsables', { status: 200 });
    }

    const idsRes = relData.map(r => r.id_res);

    // 4. Obtener los telegram_chat_id de la tabla 'responsables'
    const { data: respData, error: respError } = await supabase
      .from('responsables')
      .select('telegram_chat_id')
      .in('id_res', idsRes)
      .not('telegram_chat_id', 'is', null);

    if (respError || !respData) {
      console.error("Error al buscar responsables con Telegram");
      return new Response('Error: Error en responsables', { status: 200 });
    }

    // 5. Preparar y enviar el mensaje
    const movimiento = record.hora_salida ? "🔻 SALIDA" : "✅ INGRESO";
    const hora = record.hora_salida || record.hora_ingreso;
    const mensaje = `🔔 *AVISO DE ASISTENCIA*\n\n` +
                    `👤 *Estudiante:* ${nombreEstudiante}\n` +
                    `📍 *Evento:* ${movimiento}\n` +
                    `🕒 *Hora:* ${hora}\n` +
                    `📊 *Estado:* ${record.estado}`;

    for (const res of respData) {
      if (res.telegram_chat_id) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: res.telegram_chat_id,
            text: mensaje,
            parse_mode: 'Markdown'
          })
        });
      }
    }

    return new Response('Notificaciones enviadas con éxito', { status: 200 });

  } catch (err) {
    console.error("Error crítico en notify-attendance:", err.message);
    return new Response('Error interno', { status: 200 });
  }
})