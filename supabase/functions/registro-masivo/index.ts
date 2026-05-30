import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const { action, auth_id, dni, nombre, id_rol, activo, password } = await req.json()
    
    // 1. Crear cliente administrador del sistema
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // =================================================================
    // VALIDADOR DE SEGURIDAD EN EL SERVIDOR
    // =================================================================
    // Creamos un cliente temporal con el token del usuario que hace la llamada
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )
    
    // Obtenemos el usuario real de la sesión a través de Supabase Auth
    const { data: { user }, error: userError } = await userClient.auth.getUser()
    if (userError || !user) throw new Error("Sesión inválida o expirada.")

    // Consultamos su rol en la tabla usuarios de forma segura
    const { data: perfilUsuario, error: perfilError } = await supabaseAdmin
      .from('usuarios')
      .select('id_rol')
      .eq('auth_id', user.id)
      .single()

    if (perfilError || !perfilUsuario) throw new Error("No se pudo verificar el perfil del usuario.")

    // Supongamos que el id_rol de Administrador en tu BD es 1 (Verifica tu ID real de Admin)
    // Bloqueamos cualquier petición si el emisor NO es Administrador
    if (perfilUsuario.id_rol !== 1) {
      return new Response(JSON.stringify({ error: "Acceso denegado: No cuenta con privilegios de Administrador en el servidor." }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 403
      })
    }
    // =================================================================

    // ACCIÓN: REGISTRAR
    if (action === 'create') {
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: `${dni}@newton.edu.pe`,
        password: dni,
        email_confirm: true,
        user_metadata: { nombre_completo: nombre }
      })
      if (authError) throw authError

      await supabaseAdmin.from('usuarios').insert([{
        usuario: dni, nombre_completo: nombre, id_rol: id_rol, auth_id: authData.user.id, activo: true
      }])
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ACCIÓN: ESTADO (Habilitar/Deshabilitar)
    if (action === 'toggle_status') {
      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(auth_id, {
        ban_duration: activo ? 'none' : '87600h'
      })
      if (authError) throw authError

      await supabaseAdmin.from('usuarios').update({ activo }).eq('auth_id', auth_id)
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ACCIÓN: MODIFICAR CONTRASEÑA
    if (action === 'updatePassword') {
      if (!auth_id || !password) throw new Error("Parámetros incompletos.")
      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(auth_id, { password })
      if (authError) throw authError
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ACCIÓN: ELIMINAR
    if (action === 'delete') {
      const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(auth_id)
      if (authError) throw authError
      await supabaseAdmin.from('usuarios').delete().eq('auth_id', auth_id)
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: 'Acción no válida.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 })
  }
})