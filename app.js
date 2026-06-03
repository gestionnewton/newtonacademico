// app.js - Protección de Ruta

    async function checkSession() {
        // Verificamos si hay un usuario conectado
        const { data: { session } } = await supabaseClient.auth.getSession();

        if (!session) {
            // Si no hay sesión, lo mandamos al login inmediatamente
            window.location.href = 'login.html';
        } else {
            // Si hay sesión, cargamos los datos del usuario
            cargarDatosUsuario(session.user);
        }
    }

    //==============================================================
    

    // Función extra para que el usuario sepa en qué pestaña está (UI/UX)
    function actualizarEstadoSidebar(sectionId) {
        document.querySelectorAll('.nav-links a').forEach(link => {
            link.classList.remove('active');
            // Si el onclick contiene el ID de la sección, le ponemos la clase active
            if (link.getAttribute('onclick')?.includes(sectionId)) {
                link.classList.add('active');
            }
        });
    }


//=======================================================================
function inicializarFechaReporte() {
    const inputFecha = document.getElementById('rep-fecha-busqueda');
    if (inputFecha && !inputFecha.value) {
        const hoy = new Date();
        const offset = hoy.getTimezoneOffset();
        const hoyLocal = new Date(hoy.getTime() - (offset * 60 * 1000));
        inputFecha.value = hoyLocal.toISOString().split('T')[0];
    }
}


    //================================================================
    let html5QrCode;

    // --- CONFIGURACIÓN DE AUDIO (Videojuego Style) ---
    // Éxito: Sonido de moneda/punto ganado
    const soundSuccess = new Audio('./assets/sounds/beep-registrado.mp3'); 
    // Error: Sonido de "Buzzer" o error clásico
    const soundError = new Audio('./assets/sounds/Sonido-ErrorDeRegistro.mp3');

    function playSuccessSound() {
        soundSuccess.currentTime = 0;
        soundSuccess.volume = 0.6;
        // Las políticas de los navegadores requieren un catch para el método play()
        soundSuccess.play().catch(e => console.warn("Audio bloqueado o no disponible"));
    }

    function playErrorSound() {
        soundError.currentTime = 0;
        soundError.volume = 0.6;
        soundError.play().catch(e => console.warn("Audio bloqueado o no disponible"));
    }


    async function iniciarEscaneo() {
        html5QrCode = new Html5Qrcode("reader");
        const config = { fps: 10, qrbox: { width: 250, height: 250 } };

        try {
            await html5QrCode.start({ facingMode: "environment" }, config, onScanSuccess);
            document.getElementById('asistencia-resultado').style.display = "none";
        } catch (err) {
            alert("Error al abrir cámara: " + err);
        }
    }

    async function onScanSuccess(decodedText) {
        // decodedText contiene el auth_id (UUID)
        detenerEscaneo(); // Pausamos para procesar
        await procesarAsistencia(decodedText);
    }

    function detenerEscaneo() {
        if (html5QrCode) {
            html5QrCode.stop().catch(err => console.error(err));
        }
    }

    async function procesarAsistencia(uuid) {
        const resDiv = document.getElementById('asistencia-resultado');
        
        try {
            // 1. CONSULTA UNIFICADA: Traemos todo en un solo viaje a la DB
            // Traemos usuario + su id_est + su nivel/grado actual de la matrícula
            const { data: u, error: errU } = await supabaseClient
                .from('usuarios')
                .select(`
                    id_usu, nombre_completo, usuario, id_rol, activo,
                    estudiantes (
                        id_est,
                        matriculas (
                            secciones ( nivel, grado )
                        )
                    )
                `)
                .eq('auth_id', uuid)
                .single();

            if (errU || !u) throw new Error("Usuario no reconocido.");
            if (!u.activo) throw new Error("Usuario inactivo.");

            const ahora = new Date();
            const hoy = ahora.toISOString().split('T')[0];
            const horaActualStr = ahora.toLocaleTimeString('it-IT');

            // 2. Verificar asistencia del día
            const { data: asistenciaExistente } = await supabaseClient
                .from('asistencia')
                .select('*')
                .eq('user_auth_id', uuid)
                .eq('fecha', hoy)
                .maybeSingle();

            if (asistenciaExistente && asistenciaExistente.hora_salida) {
                throw new Error("Ya registró ingreso y salida por hoy.");
            }

            // Extraemos la info académica de la consulta unificada para evitar más await
            const infoAcademica = u.estudiantes?.[0]?.matriculas?.[0]?.secciones || null;

            if (!asistenciaExistente) {
                // Buscamos horario (Ahora esta función será más rápida porque ya tenemos la info)
                const horario = await obtenerHorarioOptimizado(u.id_rol, infoAcademica);
                
                let estadoAsis = 'PRESENTE';
                let minutosRetraso = 0;

                if (horario) {
                    const [hEntrada, mEntrada] = horario.hora_entrada.split(':').map(Number);
                    const limiteEntrada = new Date(ahora);
                    limiteEntrada.setHours(hEntrada, mEntrada + horario.tolerancia_minutos, 0);

                    if (ahora > limiteEntrada) {
                        estadoAsis = 'TARDANZA';
                        const horaBase = new Date(ahora);
                        horaBase.setHours(hEntrada, mEntrada, 0);
                        minutosRetraso = Math.floor((ahora - horaBase) / (1000 * 60));
                    }
                }

                // REGISTRO DE INGRESO
                const { error: errIns } = await supabaseClient
                    .from('asistencia')
                    .insert([{
                        user_auth_id: uuid,
                        fecha: hoy,
                        hora_ingreso: horaActualStr,
                        estado: estadoAsis,
                        minutos_tardanza: minutosRetraso,
                        id_usu_registro: (await supabaseClient.auth.getUser()).data.user.id
                    }]);

                if (errIns) throw errIns;

                // --- FEEDBACK INSTANTÁNEO ---
                playSuccessSound(); 
                const msg = estadoAsis === 'TARDANZA' ? `TARDANZA (${minutosRetraso} min)` : "¡A TIEMPO!";
                mostrarFeedback(u.nombre_completo, `INGRESO: ${horaActualStr} - ${msg}`, "green");

            } else {
                // REGISTRO DE SALIDA
                const { error: errUpd } = await supabaseClient
                    .from('asistencia')
                    .update({ hora_salida: horaActualStr })
                    .eq('id_asistencia', asistenciaExistente.id_asistencia);

                if (errUpd) throw errUpd;

                // --- FEEDBACK INSTANTÁNEO ---
                playSuccessSound();
                mostrarFeedback(u.nombre_completo, `SALIDA: ${horaActualStr}`, "blue");
            }

            // Tareas en segundo plano (No bloquean el sonido ni el mensaje)
            cargarAsistenciasRecientes();

        } catch (err) {
            playErrorSound();
            console.error("Error:", err.message);
            mostrarFeedback("Error", err.message, "red");
        } finally {
            setTimeout(iniciarEscaneo, 3000);
        }
    }

    // Función auxiliar rápida que ya no consulta la base de datos de estudiantes
    async function obtenerHorarioOptimizado(idRol, infoAcademica) {
        const hoy = new Date().toISOString().split('T')[0];
        const { data: horarios } = await supabaseClient
            .from('config_horarios')
            .select('*')
            .eq('activo', true)
            .lte('fecha_inicio', hoy)
            .order('fecha_inicio', { ascending: false });

        if (!horarios) return null;

        return horarios.find(h => {
            if (h.tipo_grupo === 'ROL') return h.valor_grupo.roles.includes(idRol);
            if (h.tipo_grupo === 'GRADO_NIVEL' && infoAcademica) {
                return h.valor_grupo.nivel === infoAcademica.nivel && 
                    h.valor_grupo.grados.includes(infoAcademica.grado);
            }
            return false;
        });
    }

    function mostrarFeedback(nombre, mensaje, color) {
        const resDiv = document.getElementById('asistencia-resultado');
        resDiv.style.display = "block";
        resDiv.style.backgroundColor = color === "green" ? "#d4edda" : (color === "red" ? "#f8d7da" : "#fff3cd");
        resDiv.style.color = color === "green" ? "#155724" : (color === "red" ? "#721c24" : "#856404");
        document.getElementById('asig-res-nombre').innerText = nombre;
        document.getElementById('asig-res-msg').innerText = mensaje;
    }

    async function cargarAsistenciasRecientes() {
        const tbody = document.getElementById('tbody-asistencias-recientes');
        if (!tbody) return;

        const hoy = new Date().toISOString().split('T')[0];

        try {
            const { data: asistencias, error } = await supabaseClient
                .from('asistencia')
                .select(`
                    id_asistencia,
                    hora_ingreso,
                    hora_salida,
                    estado,
                    usuarios!user_auth_id ( nombre_completo )
                `)
                .eq('fecha', hoy)
                .order('id_asistencia', { ascending: false })
                .limit(10); // Mostramos los últimos 10

            if (error) throw error;

            let html = '';
            asistencias.forEach(a => {
                const nombre = a.usuarios?.nombre_completo || 'Desconocido';
                const salida = a.hora_salida || '---';
                
                html += `
                    <tr>
                        <td><strong>${nombre}</strong></td>
                        <td>${a.hora_ingreso}</td>
                        <td>${salida}</td>
                        <td><span class="badge-success" style="padding: 2px 6px; font-size: 0.75rem;">${a.estado}</span></td>
                    </tr>`;
            });

            tbody.innerHTML = html || '<tr><td colspan="4" style="text-align:center;">No hay registros hoy.</td></tr>';

        } catch (err) {
            console.error("Error al cargar asistencias recientes:", err.message);
        }
        actualizarContadoresAsistencia();
    }

    async function actualizarContadoresAsistencia() {
        const hoy = new Date().toISOString().split('T')[0];

        try {
            // Consultamos las asistencias de hoy junto con el rol del usuario
            const { data, error } = await supabaseClient
                .from('asistencia')
                .select(`
                    user_auth_id,
                    usuarios!user_auth_id ( id_rol )
                `)
                .eq('fecha', hoy);

            if (error) throw error;

            // Contamos según el id_rol (4 para Docentes, 6 para Estudiantes)
            let totalEstudiantes = 0;
            let totalDocentes = 0;

            data.forEach(asig => {
                const rol = asig.usuarios?.id_rol;
                if (rol === 6) totalEstudiantes++;
                if (rol === 4) totalDocentes++;
            });

            // Actualizamos los números en la interfaz con una pequeña animación (opcional)
            document.getElementById('count-estudiantes').innerText = totalEstudiantes;
            document.getElementById('count-docentes').innerText = totalDocentes;

        } catch (err) {
            console.error("Error en contadores:", err.message);
        }
    }





    //====================================================================
    async function cargarAniosMigracion() {
        // Identificamos ambos selectores
        const selectReg = document.getElementById('select-anio-migrar');
        const selectLista = document.getElementById('select-anio-migrar-lista');
        
        // Creamos un array con los que existan en el DOM para procesarlos
        const selects = [selectReg, selectLista].filter(s => s !== null);
        
        if (selects.length === 0) return;

        // Traemos los años ordenados por creación
        const { data, error } = await supabaseClient
            .from('anio_academico')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error("Error al cargar años académicos:", error.message);
            return;
        }

        // Llenamos cada selector encontrado
        selects.forEach(select => {
            select.innerHTML = '<option value="">Seleccionar Año...</option>';
            
            data.forEach(anio => {
                const option = document.createElement('option');
                option.value = anio.id_anio;
                option.textContent = anio.nombre;
                
                if (anio.estado === 'ACTIVO') {
                    option.selected = true;
                }
                
                select.appendChild(option);
            });
        });
    }

    // Mantener el listener para la carga inicial
    document.addEventListener('DOMContentLoaded', cargarAniosMigracion);



    //JUSTIFICACIONES=====================================0
    // 1. Manejo de Pestañas internas de Asistencia
    function openAsistenciaTab(tabId) {
        document.querySelectorAll('.asis-tab-content').forEach(t => t.style.display = 'none');
        document.querySelectorAll('.tab-btn-asis').forEach(b => b.classList.remove('active'));
        
        document.getElementById('asis-' + tabId).style.display = 'block';
        event.currentTarget.classList.add('active');
    }

    

    // 3. Guardar Justificación y Actualizar Asistencia
    async function guardarJustificacion() {
        const idEst = document.getElementById('just-id-est-hidden').value;
        if (!idEst) return alert("Por favor, selecciona un estudiante de la lista.");

        const fecha = document.getElementById('just-fecha').value;
        const tipo = document.getElementById('just-tipo').value;
        const motivo = document.getElementById('just-motivo').value;

        try {
            // A. Insertar en tabla de justificaciones
            const { error: errJust } = await supabaseClient
                .from('justificaciones')
                .insert([{ id_est: idEst, fecha: fecha, tipo: tipo, motivo: motivo }]);

            if (errJust) throw errJust;

            // B. Actualizar la tabla de asistencia (Importante para que salga en el reporte)
            // Buscamos el auth_id del estudiante para poder marcar su asistencia como JUSTIFICADO
            const { data: estData } = await supabaseClient.from('estudiantes').select('dni').eq('id_est', idEst).single();
            const { data: usuData } = await supabaseClient.from('usuarios').select('auth_id').eq('usuario', estData.dni).single();

            if (usuData && usuData.auth_id) {
                // Upsert: Si ya existe la falta la actualiza, si no, la crea como justificativa
                await supabaseClient
                    .from('asistencia')
                    .upsert({ 
                        user_auth_id: usuData.auth_id, 
                        fecha: fecha, 
                        estado: 'JUSTIFICADO',
                        observacion: motivo 
                    }, { onConflict: 'user_auth_id, fecha' });
            }

            alert("Justificación registrada y asistencia actualizada.");
            document.getElementById('form-justificacion').reset();

        } catch (err) {
            alert("Error: " + err.message);
        }
    }


    let listaEstudiantesActivos = []; // Variable global para el buscador

    // 1. Cargar la lista en memoria al abrir la pestaña
    async function cargarEstudiantesActivosJust() {
        const input = document.getElementById('just-search-input');
        input.value = ''; // Limpiar búsqueda previa
        document.getElementById('just-id-est-hidden').value = '';

        try {
            const { data, error } = await supabaseClient
                .from('matriculas')
                .select('estudiantes(id_est, apellido_paterno, apellido_materno, nombres)')
                .eq('estado', 'ACTIVO');

            if (error) throw error;

            // Guardar y formatear
            listaEstudiantesActivos = data.map(m => ({
                id: m.estudiantes.id_est,
                nombre: `${m.estudiantes.apellido_paterno} ${m.estudiantes.apellido_materno}, ${m.estudiantes.nombres}`.toUpperCase()
            })).sort((a, b) => a.nombre.localeCompare(b.nombre));

        } catch (err) {
            console.error("Error cargando estudiantes:", err);
        }
    }

    
    function filtrarEstudiantesJust(busqueda) {
        const listaHtml = document.getElementById('just-results-list');
        const btnClear = document.getElementById('btn-clear-just');
        
        // Muestra la X solo si hay texto
        if (busqueda.length > 0) {
            btnClear.style.display = 'flex'; // Usamos flex para centrar el icono
        } else {
            btnClear.style.display = 'none';
            listaHtml.style.display = 'none';
            return;
        }

        if (busqueda.length < 2) {
            listaHtml.style.display = 'none';
            return;
        }

        // Filtrado en la variable global listaEstudiantesActivos
        const filtrados = listaEstudiantesActivos.filter(e => 
            e.nombre.includes(busqueda.toUpperCase())
        );

        if (filtrados.length > 0) {
            listaHtml.innerHTML = filtrados.map(e => `
                <div class="search-item" onclick="seleccionarEstudianteJust(${e.id}, '${e.nombre}')">
                    ${e.nombre}
                </div>
            `).join('');
            listaHtml.style.display = 'block';
        } else {
            listaHtml.innerHTML = '<div class="search-item" style="color:#94a3b8;">No se encontraron resultados</div>';
            listaHtml.style.display = 'block';
        }
    }

    function limpiarBuscadorJust() {
        document.getElementById('just-search-input').value = '';
        document.getElementById('just-id-est-hidden').value = '';
        document.getElementById('just-results-list').style.display = 'none';
        document.getElementById('btn-clear-just').style.display = 'none';
        document.getElementById('just-search-input').focus();
    }

    function seleccionarEstudianteJust(id, nombre) {
        document.getElementById('just-search-input').value = nombre;
        document.getElementById('just-id-est-hidden').value = id;
        document.getElementById('just-results-list').style.display = 'none';
        // Mantenemos la X visible por si quiere cambiar de opinión
        document.getElementById('btn-clear-just').style.display = 'flex'; 
    }







    // Esta función se ejecuta apenas carga la página
    checkSession();

    // Vincular el botón de cerrar sesión
    document.getElementById('btn-logout').addEventListener('click', (e) => {
        e.preventDefault();
        logout(); // Función que definimos en auth.js
    });



    //============================================
    //NAVEGACIÓN DE SUB-PESTAÑAS
    function openSubTab(subTabName) {
        document.querySelectorAll('.sub-config-content').forEach(c => c.style.display = 'none');
        document.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
        
        document.getElementById('sub-tab-' + subTabName).style.display = 'block';
        event.currentTarget.classList.add('active');
    }

    //============================================
    async function cargarVistaSecciones() {
        const container = document.getElementById('container-vista-secciones');
        const idAnio = document.getElementById('asig-anio').value;

        if (!idAnio) {
            container.innerHTML = '<p style="color:orange;">Seleccione un Año Académico en la pestaña "Nueva Asignación".</p>';
            return;
        }

        container.innerHTML = 'Cargando asignaciones...';

        try {
            const { data: asignaciones, error } = await supabaseClient
                .from('cursos_asignados')
                .select(`
                    id_asignacion,
                    cursos (nombre_curso),
                    usuarios!cursos_asignados_id_docente_fkey (nombre_completo), 
                    secciones!inner (id_sec, nivel, grado, nombre_sec, id_anio)
                `)
                .eq('secciones.id_anio', idAnio);

            if (error) throw error;

            const agrupado = {};
            asignaciones.forEach(asig => {
                const { nivel, grado, nombre_sec } = asig.secciones;
                if (!agrupado[nivel]) agrupado[nivel] = {};
                if (!agrupado[nivel][grado]) agrupado[nivel][grado] = {};
                if (!agrupado[nivel][grado][nombre_sec]) agrupado[nivel][grado][nombre_sec] = [];
                agrupado[nivel][grado][nombre_sec].push(asig);
            });

            let html = '';
            for (const nivel in agrupado) {
                html += `<h5 style="background:var(--azul-oscuro); color:white; padding:8px; margin-top:15px; border-radius:4px;">${nivel}</h5>`;
                for (const grado in agrupado[nivel]) {
                    html += `
                    <div class="acordeon-item" style="margin-top:5px; border:1px solid #ddd;">
                        <div class="acordeon-header" style="padding:10px; background:#f0f0f0; cursor:pointer; font-weight:bold;" 
                            onclick="const body = this.nextElementSibling; body.style.display = body.style.display === 'block' ? 'none' : 'block'">
                            ${grado} <span style="float:right;">▼</span>
                        </div>
                        <div class="acordeon-body" style="display:none; padding:10px;">`;
                    
                    for (const sec in agrupado[nivel][grado]) {
                        html += `
                        <div style="margin-bottom:12px; padding-left:10px; border-left:3px solid #007bff;">
                            <strong style="color:#333;">Sección: ${sec}</strong>
                            <ul style="margin: 5px 0 0 15px; font-size:0.9rem;">
                                ${agrupado[nivel][grado][sec].map(a => `
                                    <li style="margin-bottom:3px;">
                                        <b>${a.cursos.nombre_curso}</b> - <span style="color:#555;">${a.usuarios.nombre_completo}</span>
                                    </li>
                                `).join('')}
                            </ul>
                        </div>`;
                    }
                    html += `</div></div>`;
                }
            }
            container.innerHTML = html || '<p>No hay cursos asignados para este año.</p>';
        } catch (err) {
            container.innerHTML = '<p style="color:red;">Error: ' + err.message + '</p>';
        }
    }

    async function cargarVistaDocentes() {
        const container = document.getElementById('container-vista-docentes');
        const idAnio = document.getElementById('asig-anio').value;

        if (!idAnio) {
            container.innerHTML = '<p style="color:orange;">Seleccione un Año Académico en la pestaña "Nueva Asignación".</p>';
            return;
        }

        container.innerHTML = 'Cargando carga horaria por docente...';

        try {
            // Consultamos directamente las asignaciones filtradas por año
            // Usamos el nombre de la relación que descubriste: cursos_asignados_id_docente_fkey
            const { data: asignaciones, error } = await supabaseClient
                .from('cursos_asignados')
                .select(`
                    id_asignacion,
                    cursos (nombre_curso),
                    secciones (nivel, grado, nombre_sec),
                    usuarios!cursos_asignados_id_docente_fkey (id_usu, nombre_completo)
                `)
                .eq('id_anio', idAnio);

            if (error) throw error;

            // Agrupamos los datos por Docente en memoria
            const docentesAgrupados = {};

            asignaciones.forEach(asig => {
                const docente = asig.usuarios;
                if (!docente) return; // Por si hay basura en la BD

                if (!docentesAgrupados[docente.id_usu]) {
                    docentesAgrupados[docente.id_usu] = {
                        nombre: docente.nombre_completo,
                        listaAsignaciones: []
                    };
                }
                docentesAgrupados[docente.id_usu].listaAsignaciones.push(asig);
            });

            // Convertimos el objeto en HTML
            let html = '';
            const idsDocentes = Object.keys(docentesAgrupados);

            idsDocentes.forEach(id => {
                const doc = docentesAgrupados[id];
                html += `
                <div class="acordeon-item" style="margin-bottom:10px; border:1px solid #ddd; border-radius:5px;">
                    <div class="acordeon-header" style="padding:12px; background:#f9f9f9; cursor:pointer; display:flex; justify-content:space-between; align-items:center;"
                        onclick="const body = this.nextElementSibling; body.style.display = body.style.display === 'block' ? 'none' : 'block'">
                        <strong>${doc.nombre}</strong>
                        <span style="background:var(--azul-primario); color:white; padding:2px 8px; border-radius:10px; font-size:0.8rem;">
                            ${doc.listaAsignaciones.length} cursos
                        </span>
                    </div>
                    <div class="acordeon-body" style="display:none; padding:15px; background:white;">
                        <table style="width:100%; border-collapse:collapse; font-size:0.85rem;">
                            <thead style="background:#f0f0f0; text-align:left;">
                                <tr>
                                    <th style="padding:8px; border:1px solid #eee;">Curso</th>
                                    <th style="padding:8px; border:1px solid #eee;">Nivel</th>
                                    <th style="padding:8px; border:1px solid #eee;">Grado / Sec</th>
                                    <th style="padding:8px; border:1px solid #eee; text-align:center;">Borrar</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${doc.listaAsignaciones.map(a => `
                                    <tr>
                                        <td style="padding:8px; border:1px solid #eee;">${a.cursos?.nombre_curso || 'N/A'}</td>
                                        <td style="padding:8px; border:1px solid #eee;">${a.secciones?.nivel || 'N/A'}</td>
                                        <td style="padding:8px; border:1px solid #eee;">${a.secciones?.grado || 'N/A'} - ${a.secciones?.nombre_sec || 'N/A'}</td>
                                        <td style="padding:8px; border:1px solid #eee; text-align:center;">
                                            <button class="btn-error btn-sm" onclick="eliminarAsignacion('${a.id_asignacion}')">
                                                <span class="material-symbols-outlined" style="font-size:16px;">delete</span>
                                            </button>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>`;
            });

            container.innerHTML = html || '<p>No se encontraron asignaciones para el año seleccionado.</p>';

        } catch (err) {
            console.error("Error en cargarVistaDocentes:", err);
            container.innerHTML = '<p style="color:red;">Error al procesar la vista: ' + err.message + '</p>';
        }
    }

    //============================================
    // --- FUNCIONES DE CARGA INICIAL PARA SELECTS ---
    // --- CARGA INICIAL DE SELECTS ---
    async function cargarSelectsAsignacion() {
        try {
            // 1. Cargar Años Académicos ACTIVOS
            // Usamos { data, error } para que 'error' sí esté definido
            const { data: anos, error: errAnio } = await supabaseClient
                .from('anio_academico')
                .select('id_anio, nombre')
                .or('estado.eq.ACTIVO,estado.eq.activo');

            if (errAnio) throw errAnio;

            const selAnio = document.getElementById('asig-anio');
            if (selAnio) {
                selAnio.innerHTML = '<option value="">Seleccionar Año Académico</option>' + 
                    (anos || []).map(a => `<option value="${a.id_anio}">${a.nombre}</option>`).join('');
            }

            // 2. Cargar Docentes (Rol 4)
            const { data: docentes, error: errDoc } = await supabaseClient
                .from('usuarios')
                .select('id_usu, nombre_completo')
                .eq('id_rol', 4);

            if (errDoc) throw errDoc;

            const selDoc = document.getElementById('asig-docente');
            if (selDoc) {
                selDoc.innerHTML = '<option value="">Seleccionar Docente</option>' + 
                    (docentes || []).map(d => `<option value="${d.id_usu}">${d.nombre_completo}</option>`).join('');
            }

            // 3. Cargar Cursos
            const { data: cursos, error: errCur } = await supabaseClient
                .from('cursos')
                .select('id_curso, nombre_curso');

            if (errCur) throw errCur;

            const selCur = document.getElementById('asig-curso');
            if (selCur) {
                selCur.innerHTML = '<option value="">Seleccionar Curso</option>' + 
                    (cursos || []).map(c => `<option value="${c.id_curso}">${c.nombre_curso}</option>`).join('');
            }

        } catch (err) {
            // Aquí 'err' siempre estará definido por el catch
            console.error("Error al cargar selects:", err.message || err);
        }
    }


    async function eliminarAsignacion(idAsignacion) {
        if (!confirm("¿Seguro que desea eliminar esta asignación?")) return;

        try {
            const { error } = await supabaseClient
                .from('cursos_asignados')
                .delete()
                .eq('id_asignacion', idAsignacion); // Usando id_asignacion correctamente

            if (error) throw error;

            // Recargamos la vista actual
            cargarVistaDocentes();
            cargarVistaSecciones();
        } catch (err) {
            alert("Error al eliminar: " + err.message);
        }
    }

    // --- FILTROS DINÁMICOS DE SECCIÓN ---

    // Al cambiar el Año -> Cargar Niveles
    document.getElementById('asig-anio').addEventListener('change', async (e) => {
        const idAnio = e.target.value;
        const selNivel = document.getElementById('asig-nivel');
        const wrapper = document.getElementById('wrapper-secciones');

        // Limpiamos la vista si se cambia el año
        if (wrapper) wrapper.style.display = 'none';

        if (!idAnio) {
            if (selNivel) {
                selNivel.value = "";
                selNivel.disabled = true;
            }
            return;
        }

        try {
            // Obtenemos niveles únicos para el año seleccionado
            const { data: secciones, error } = await supabaseClient
                .from('secciones')
                .select('nivel')
                .eq('id_anio', idAnio);

            if (error) throw error;

            const nivelesUnicos = [...new Set(secciones.map(s => s.nivel))];

            if (selNivel) {
                selNivel.innerHTML = '<option value="">Seleccionar Nivel</option>' + 
                    nivelesUnicos.map(n => `<option value="${n}">${n}</option>`).join('');
                selNivel.disabled = false;
            }
        } catch (err) {
            console.error("Error al cargar niveles:", err.message);
        }
    });

    document.getElementById('asig-nivel').addEventListener('change', async (e) => {
        const nivel = e.target.value;
        const idAnio = document.getElementById('asig-anio').value;
        const wrapper = document.getElementById('wrapper-secciones');
        const contenedor = document.getElementById('contenedor-secciones-check');
        const btn = document.getElementById('btn-realizar-asig');

        if (!nivel) {
            wrapper.style.display = 'none';
            btn.disabled = true;
            return;
        }

        // Traemos todas las secciones del nivel y año seleccionado
        const { data: secciones, error } = await supabaseClient
            .from('secciones')
            .select('id_sec, grado, nombre_sec')
            .eq('id_anio', idAnio)
            .eq('nivel', nivel)
            .order('grado', { ascending: true })
            .order('nombre_sec', { ascending: true });

        if (error) {
            console.error("Error al cargar secciones:", error.message);
            return;
        }

        // Agrupar por grado para una mejor visualización
        let html = '';
        let ultimoGrado = '';

        secciones.forEach(s => {
            if (s.grado !== ultimoGrado) {
                html += `<div style="grid-column: 1 / -1; font-weight: bold; color: var(--azul-oscuro); margin-top: 10px; border-bottom: 1px solid #ccc;">${s.grado}</div>`;
                ultimoGrado = s.grado;
            }
            html += `
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; background: white; padding: 5px 10px; border-radius: 4px; border: 1px solid #eee;">
                    <input type="checkbox" class="check-asig-sec" value="${s.id_sec}">
                    <span>${s.nombre_sec}</span>
                </label>`;
        });

        contenedor.innerHTML = html || '<p>No hay secciones creadas en este nivel.</p>';
        wrapper.style.display = 'block';
        btn.disabled = false;
    });

    // --- REALIZAR ASIGNACIÓN ---ACTUALIZADO ---
    document.getElementById('form-asignacion')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('btn-realizar-asig');
        
        // Obtener todas las secciones marcadas
        const checkboxes = document.querySelectorAll('.check-asig-sec:checked');
        if (checkboxes.length === 0) {
            alert("Por favor, seleccione al menos una sección.");
            return;
        }

        const idAnio = document.getElementById('asig-anio').value;
        const idUsu = document.getElementById('asig-docente').value;
        const idCurso = document.getElementById('asig-curso').value;
        const seccionesIds = Array.from(checkboxes).map(cb => cb.value);

        btn.disabled = true;
        btn.innerText = "Procesando...";

        try {
            // Preparamos el array de objetos para una inserción masiva (Bulk Insert)
            const asignaciones = seccionesIds.map(idSec => ({
                id_usu: idUsu,
                id_curso: idCurso,
                id_sec: idSec,
                id_anio: idAnio
            }));

            const { error } = await supabaseClient
                .from('cursos_asignados')
                .insert(asignaciones);

            if (error) throw error;

            alert(`¡Éxito! Se han realizado ${asignaciones.length} asignaciones correctamente.`);
            
            // Limpiar formulario
            e.target.reset();
            document.getElementById('wrapper-secciones').style.display = 'none';
            document.querySelectorAll('#asig-nivel').forEach(s => s.disabled = true);
            btn.disabled = true;

        } catch (err) {
            console.error("Error en asignación masiva:", err.message);
            alert("Error: " + err.message);
        } finally {
            btn.disabled = false;
            btn.innerText = "Realizar Asignación Masiva";
        }
    });





    

    //============================================

    // --- CREAR CURSO ---
    document.getElementById('form-curso')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const nombre = document.getElementById('cur-nombre').value;
        const abre = document.getElementById('cur-abre').value;
        const inputsComp = document.querySelectorAll('.comp-input');
        
        try {
            // 1. Insertar el Curso
            const { data: cursoInsertado, error: errorCurso } = await supabaseClient
                .from('cursos')
                .insert([{ nombre_curso: nombre, abreviatura: abre }])
                .select()
                .single();

            if (errorCurso) throw errorCurso;

            // 2. Preparar las competencias para insertar
            const competencias = Array.from(inputsComp).map(input => ({
                id_curso: cursoInsertado.id_curso,
                descripcion_competencia: input.value
            }));

            // 3. Insertar Competencias en lote
            const { error: errorComp } = await supabaseClient
                .from('competencias')
                .insert(competencias);

            if (errorComp) throw errorComp;

            alert("¡Éxito! Curso y competencias creados correctamente.");
            e.target.reset();
            // Limpiar filas extra de competencias
            document.getElementById('contenedor-competencias').innerHTML = `
                <label style="font-weight: bold; font-size: 0.9rem;">Competencias del Curso:</label>
                <div class="fila-competencia" style="display: flex; gap: 10px; margin-top: 5px;">
                    <input type="text" class="input-style comp-input" placeholder="Descripción de la competencia" required style="flex-grow: 1;">
                    <button type="button" class="btn-primary" onclick="agregarFilaCompetencia()" style="padding: 5px 15px;">+</button>
                </div>
            `;
            
            // Actualizar los selects de la pestaña de asignación si es necesario
            if (typeof cargarSelectsAsignacion === 'function') cargarSelectsAsignacion();

        } catch (err) {
            console.error("Error al crear curso:", err.message);
            alert("Error al guardar: " + err.message);
        }
    });

    // Función para añadir más campos de competencia en el formulario
    function agregarFilaCompetencia() {
        const container = document.getElementById('contenedor-competencias');
        const div = document.createElement('div');
        div.className = 'fila-competencia';
        div.style = 'display: flex; gap: 10px; margin-top: 5px;';
        div.innerHTML = `
            <input type="text" class="input-style comp-input" placeholder="Otra competencia" required style="flex-grow: 1;">
            <button type="button" class="btn-danger" onclick="this.parentElement.remove()" style="padding: 5px 15px;">-</button>
        `;
        container.appendChild(div);
    }

    async function listarCursos() {
        const container = document.getElementById('lista-cursos-container');
        if (!container) return;
        
        container.innerHTML = '<p style="color: blue;">Cargando cursos y competencias...</p>';

        try {
            // Ajuste de nombres de columnas según tu esquema
            const { data: cursos, error } = await supabaseClient
                .from('cursos')
                .select(`
                    id_curso, 
                    nombre_curso, 
                    abreviatura, 
                    competencias (id_competencia, descripcion_competencia)
                `)
                .order('nombre_curso', { ascending: true });

            if (error) throw error;

            let html = '';
            cursos.forEach(c => {
                html += `
                    <div class="curso-item" style="border: 1px solid #ddd; border-radius: 8px; margin-bottom: 10px; overflow: hidden;">
                        <div class="curso-header" onclick="toggleDetalleCurso('${c.id_curso}')" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; background: #f8f9fa; cursor: pointer;">
                            <div>
                                <strong>${c.nombre_curso}</strong> <small style="color:gray;">(${c.abreviatura})</small>
                            </div>
                            <div style="display:flex; gap:10px; align-items:center;">
                                <span class="material-symbols-outlined">expand_more</span>
                                <button class="btn-primary btn-sm" onclick="event.stopPropagation(); abrirModalEditarCurso('${c.id_curso}')" style="padding: 4px 8px;">
                                    <span class="material-symbols-outlined" style="font-size:18px;">edit</span>
                                </button>
                            </div>
                        </div>
                        <div id="detalle-${c.id_curso}" class="competencias-detalle" style="padding: 15px; background: white; border-top: 1px solid #eee; display: none;">
                            <p style="font-weight:bold; font-size:0.8rem; color:#666; margin-bottom: 8px;">COMPETENCIAS:</p>
                            ${c.competencias.length > 0 
                                ? c.competencias.map(comp => `<div style="font-size: 0.9rem; padding: 4px 0; border-bottom: 1px solid #fafafa;">• ${comp.descripcion_competencia}</div>`).join('')
                                : '<p style="color:gray; font-size:0.8rem;">Sin competencias registradas.</p>'}
                        </div>
                    </div>`;
            });
            container.innerHTML = html || '<p>No hay cursos registrados todavía.</p>';
        } catch (err) {
            console.error("Error en listarCursos:", err.message);
            container.innerHTML = '<p style="color:red">Error al cargar cursos. Verifica la consola.</p>';
        }
    }

    function toggleDetalleCurso(id) {
        const el = document.getElementById('detalle-' + id);
        if (el) {
            el.style.display = el.style.display === 'block' ? 'none' : 'block';
        }
    }
    

    
    
    async function abrirModalEditarCurso(idCurso) {
        const modal = document.getElementById('modal-editar-curso');
        modal.style.display = 'flex';

        try {
            const { data: curso, error } = await supabaseClient
                .from('cursos')
                .select(`*, competencias (*)`)
                .eq('id_curso', idCurso)
                .single();

            if (error) throw error;

            document.getElementById('edit-cur-id').value = curso.id_curso;
            document.getElementById('edit-cur-nombre').value = curso.nombre_curso;
            document.getElementById('edit-cur-abre').value = curso.abreviatura;
            
            const cont = document.getElementById('contenedor-edit-competencias');
            cont.innerHTML = '<label style="font-weight: bold; font-size: 0.9rem;">Competencias:</label>';
            
            curso.competencias.forEach(comp => {
                cont.innerHTML += `
                    <div class="fila-edit-comp" style="display:flex; gap:5px; margin-top:5px;">
                        <input type="text" class="input-style edit-comp-input" value="${comp.descripcion_competencia}" style="flex:1;">
                        <button type="button" class="btn-error" onclick="this.parentElement.remove()" style="padding: 0 10px;">X</button>
                    </div>`;
            });
        } catch (err) {
            alert("Error al cargar datos del curso: " + err.message);
        }
    }

    function agregarFilaEditComp() {
        const cont = document.getElementById('contenedor-edit-competencias');
        cont.insertAdjacentHTML('beforeend', `
            <div class="fila-edit-comp" style="display:flex; gap:5px; margin-bottom:5px;">
                <input type="text" class="input-style edit-comp-input" placeholder="Nueva competencia" style="flex:1;">
                <button type="button" class="btn-error" onclick="this.parentElement.remove()">X</button>
            </div>`);
    }

    document.getElementById('form-edit-curso').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('edit-cur-id').value;
        const nombre = document.getElementById('edit-cur-nombre').value;
        const abre = document.getElementById('edit-cur-abre').value;
        const comps = Array.from(document.querySelectorAll('.edit-comp-input'))
                        .map(i => i.value.trim())
                        .filter(v => v !== "");

        try {
            // 1. Actualizar datos básicos del curso
            const { error: errCurso } = await supabaseClient
                .from('cursos')
                .update({ 
                    nombre_curso: nombre, 
                    abreviatura: abre 
                })
                .eq('id_curso', id);

            if (errCurso) throw errCurso;

            // 2. Sincronizar competencias: Borramos las actuales y subimos las nuevas
            await supabaseClient.from('competencias').delete().eq('id_curso', id);
            
            if (comps.length > 0) {
                const nuevasComps = comps.map(c => ({ 
                    id_curso: id, 
                    descripcion_competencia: c 
                }));
                const { error: errComp } = await supabaseClient.from('competencias').insert(nuevasComps);
                if (errComp) throw errComp;
            }

            alert("Curso y competencias actualizados correctamente.");
            cerrarModalCurso();
            listarCursos(); // Recargar la lista
        } catch (err) {
            alert("Error al guardar cambios: " + err.message);
        }
    });

    function cerrarModalCurso() {
        document.getElementById('modal-editar-curso').style.display = 'none';
    }



    // --- GUARDAR PERIODO (Bimestre/Trimestre) ---
    const formPeriodo = document.getElementById('form-periodo');

    if (formPeriodo) {
        formPeriodo.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const nombre = document.getElementById('per-nombre').value;
            const inicio = document.getElementById('per-inicio').value;
            const fin = document.getElementById('per-fin').value;

            try {
                // 1. Buscamos el id_anio del registro "ACTIVO" más reciente
                const { data: anio, error: errorAnio } = await supabaseClient
                    .from('anio_academico')
                    .select('id_anio')
                    .eq('estado', 'ACTIVO') // Cambio: Usamos el texto exacto que mencionas
                    .order('created_at', { ascending: false }) // Tomamos el más reciente
                    .limit(1)
                    .single();

                if (errorAnio || !anio) {
                    throw new Error("No se encontró ningún año académico con estado 'ACTIVO' en la base de datos.");
                }

                // 2. Insertamos el periodo usando ese ID encontrado
                const { error: errorInsert } = await supabaseClient
                    .from('periodos_evaluacion')
                    .insert([{
                        nombre_periodo: nombre,
                        fecha_inicio: inicio,
                        fecha_fin: fin,
                        id_anio: anio.id_anio,
                        activo: false 
                    }]);

                if (errorInsert) throw errorInsert;

                alert("Periodo guardado correctamente para el año académico actual.");
                formPeriodo.reset();
                cargarListaPeriodos(); 

            } catch (err) {
                console.error("Error al guardar periodo:", err.message);
                alert("Atención: " + err.message);
            }
        });
    }

    // --- FUNCIÓN PARA MOSTRAR PERIODOS ---
    async function cargarListaPeriodos() {
        const listaDiv = document.getElementById('lista-periodos');
        if (!listaDiv) return;

        const { data: periodos, error } = await supabaseClient
            .from('periodos_evaluacion')
            .select('*')
            .order('fecha_inicio', { ascending: true });

        if (error) return;

        let html = `
            <table class="tabla-app" style="width:100%; margin-top:10px;">
                <thead>
                    <tr>
                        <th>Nombre</th>
                        <th>Inicio / Fin</th>
                        <th>Estado</th>
                        <th>Acción</th>
                    </tr>
                </thead>
                <tbody>
        `;

        periodos.forEach(p => {
            const estadoLabel = p.activo 
                ? '<span class="badge bg-success">ACTIVO</span>' 
                : '<span class="badge bg-danger">CERRADO</span>';
            
            const botonAccion = p.activo 
                ? '<button class="btn-secondary" disabled>En curso</button>' 
                : `<button class="btn-primary-sm" onclick="confirmarActivacion('${p.id_periodo}', '${p.nombre_periodo}')">Activar</button>`;

            html += `
                <tr>
                    <td><strong>${p.nombre_periodo}</strong></td>
                    <td>${p.fecha_inicio} a ${p.fecha_fin}</td>
                    <td>${estadoLabel}</td>
                    <td>${botonAccion}</td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        listaDiv.innerHTML = html;
    }

    // Llamar a la carga inicial de la lista
    cargarListaPeriodos();



    //============================================
    // app.js - Cargar info del usuario

    async function cargarDatosUsuario(authUser) {
        try {
            const { data: usuario, error } = await supabaseClient
                .from('usuarios')
                .select('nombre_completo, id_rol, id_usu, roles(nombre_rol)')
                .eq('auth_id', authUser.id)
                .single();

            if (error) throw error;

            // 1. Obtener el nombre del rol en mayúsculas para la lógica interna de seguridad
            const nombreRol = usuario.roles?.nombre_rol ? usuario.roles.nombre_rol.toUpperCase() : '';
            
            // =================================================================
            // CORREGIDO: Formatear el Rol para el saludo (Solo primera letra en Mayúscula)
            // =================================================================
            const rolFormateado = nombreRol 
                ? nombreRol.charAt(0).toUpperCase() + nombreRol.slice(1).toLowerCase() 
                : '';

            // Saludo personalizado estético (Ej: "¡Hola, Docente RICARDO ALONSO...!")
            document.getElementById('user-welcome').innerText = `¡Hola, ${rolFormateado} ${usuario.nombre_completo}!`;

            // GUARDAR EL ROL GLOBALMENTE EN MAYÚSCULAS PARA RESPALDO DE SEGURIDAD INTERNA
            window.miRolUsuario = nombreRol; 
            // =================================================================

            // Consulta dinámica de permisos por tabla
            const { data: rpData, error: rpError } = await supabaseClient
                .from('rol_permisos')
                .select('permisos!inner(slug)')
                .eq('id_rol', usuario.id_rol);

            if (rpError) throw rpError;

            const listaSlugs = rpData.map(item => item.permisos.slug);
            window.misPermisosUsuario = listaSlugs;


            //===========================================================
            // --- DENTRO DE TU FUNCIÓN cargarDatosUsuario(authUser) ---
            // Coloca este bloque justo antes de: configurarMenuPorRol(usuario.id_rol, listaSlugs);

                    // Inicializamos el contenedor global de secciones de tutoría
                    window.misSeccionesTutoria = [];

                    // Si el usuario es un Docente (id_rol === 4), buscamos si tiene el curso de Tutoría (id_curso = 14)
                    if (usuario.id_rol === 4) {
                        try {
                            const { data: tutorias, error: errTuto } = await supabaseClient
                                .from('cursos_asignados')
                                .select('id_sec')
                                .eq('id_usu', usuario.id_usu)
                                .eq('id_curso', 14); // 14 = ID del curso de Tutoría

                            if (!errTuto && tutorias) {
                                // Guardamos un arreglo plano de IDs de secciones: [1, 5, 12...]
                                window.misSeccionesTutoria = tutorias.map(t => t.id_sec);
                            }
                        } catch (tutoErr) {
                            console.error("Error al mapear asignación de tutoría:", tutoErr);
                        }
                    }


            configurarMenuPorRol(usuario.id_rol, listaSlugs);

            // Mostrar pestaña de permisos de rol si es Administrador
            const btnTabPermisos = document.getElementById('btn-tab-permisos');
            if (btnTabPermisos) {
                if (nombreRol === 'ADMINISTRADOR' || nombreRol === 'ADMIN') {
                    btnTabPermisos.style.display = 'block';
                } else {
                    btnTabPermisos.style.display = 'none';
                }
            }

            if (usuario.id_rol === 4) {
                cargarDashboardDocente(usuario.id_usu);
            } else if (usuario.id_rol === 5) {
                cargarDashboardPadre(usuario.id_usu);
            }

        } catch (error) {
            console.error("Error al cargar perfil y permisos:", error.message);
        }
    }


    async function cargarDashboardDocente(idUsu) {
        const dashboardContainer = document.getElementById('dashboard-content');
        if (!dashboardContainer) return;

        dashboardContainer.innerHTML = '<p style="text-align:center; padding:30px; color:#64748b; font-weight:600;">Sincronizando asignaciones académicas...</p>';

        try {
            // CORREGIDO: Añadimos id_curso e id_curso dentro del join de la relación fk_cursos
            const { data: asignaciones, error } = await supabaseClient
                .from('cursos_asignados')
                .select(`
                    id_asignacion,
                    id_sec,
                    id_curso,
                    cursos!fk_cursos(id_curso, nombre_curso),
                    secciones!fk_secciones(nombre_sec, grado, nivel)
                `)
                .eq('id_usu', idUsu);

            if (error) throw error;

            if (!asignaciones || asignaciones.length === 0) {
                dashboardContainer.innerHTML = `
                    <div class="card shadow-soft" style="text-align:center; padding: 40px 20px;">
                        <span class="material-symbols-outlined" style="font-size:48px; color:#94a3b8; margin-bottom:10px;">info</span>
                        <p style="color:#475569; font-weight:600; margin:0;">Aún no cuenta con cargas horarias asignadas para el año lectivo en curso.</p>
                        <small style="color:#94a3b8;">Por favor, contacte con la Dirección del plantel para su vinculación.</small>
                    </div>`;
                return;
            }

            // Agrupar asignaciones por combinación única de Grado + Nivel
            const gruposGrado = {};

            asignaciones.forEach(item => {
                if (!item.secciones) return;
                const grado = item.secciones.grado;
                const nivel = item.secciones.nivel;
                const key = `${grado}-${nivel}`.toUpperCase();

                if (!gruposGrado[key]) {
                    gruposGrado[key] = {
                        grado: grado,
                        nivel: nivel,
                        lista: []
                    };
                }
                gruposGrado[key].lista.push(item);
            });

            // Ordenar los bloques de grados de forma ascendente
            const clavesOrdenadas = Object.keys(gruposGrado).sort((a, b) => a.localeCompare(b));

            let html = '<div class="grid-cards-docente">';

            clavesOrdenadas.forEach(key => {
                const grupo = gruposGrado[key];
                
                html += `
                    <div class="card-grado-docente">
                        <div class="card-header-main">
                            <span class="material-symbols-outlined header-icon">school</span>
                            <div class="card-header-info">
                                <h3>${grupo.grado} Grado</h3>
                                <p>${grupo.nivel}</p>
                            </div>
                        </div>
                        
                        <button type="button" class="btn-card-toggle" onclick="toggleCardAccordion(this)">
                            <span>Ver Secciones y Cursos</span>
                            <span class="material-symbols-outlined toggle-icon">expand_more</span>
                        </button>
                        
                        <div class="card-accordion-content" style="display: none;">
                            <ul class="lista-asignaciones-card">`;

                grupo.lista.forEach(asig => {
                    const nombreCurso = asig.cursos?.nombre_curso || 'Curso no definido';
                    const nombreSec = asig.secciones?.nombre_sec || '-';
                    const idCurso = asig.id_curso || asig.cursos?.id_curso || 0;
                    
                    const detalleAula = `${grupo.grado} ${nombreSec} ${grupo.nivel}`;

                    const nombreCursoEscapado = nombreCurso.replace(/'/g, "\\'");
                    const detalleAulaEscapado = detalleAula.replace(/'/g, "\\'");

                    // CORREGIDO: Ahora pasamos idCurso de manera explícita como tercer parámetro
                    html += `
                        <li onclick="abrirModalVisualizacionNotas(${asig.id_asignacion}, ${asig.id_sec}, ${idCurso}, '${nombreCursoEscapado}', '${detalleAulaEscapado}')">
                            <div class="asig-item-left">
                                <span class="material-symbols-outlined item-icon">menu_book</span>
                                <span class="asig-name">${nombreCurso}</span>
                            </div>
                            <span class="badge-seccion"> "${nombreSec}"</span>
                        </li>`;
                });

                html += `
                            </ul>
                        </div>
                    </div>`;
            });

            html += '</div>';
            dashboardContainer.innerHTML = html;

        } catch (err) {
            console.error("Error estructurando el Dashboard del Docente:", err.message);
            dashboardContainer.innerHTML = '<p style="color:red; font-weight:600; text-align:center;">Fallo de enlace al procesar el dashboard.</p>';
        }
    }

    /**
     * Abre una ventana modal dinámica en MODO LECTURA con la sábana completa de notas.
     */
    async function abrirModalVisualizacionNotas(idAsignacion, idSec, idCurso, nombreCurso, detalleAula) {
        // 1. Construcción del esqueleto del Modal en el DOM
        const modalOverlay = document.createElement('div');
        modalOverlay.className = 'modal-view-overlay';
        
        modalOverlay.innerHTML = `
            <div class="modal-view-box" style="max-width: 950px;">
                <div class="modal-view-header">
                    <div class="modal-view-title">
                        <h3>Registro Histórico de Calificaciones</h3>
                        <p>${nombreCurso} - ${detalleAula}</p>
                    </div>
                    <button class="btn-modal-view-close" title="Cerrar ventana">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="modal-view-body">
                    <div style="text-align:center; padding:30px; color:#64748b;" id="modal-view-loading">
                        Sincronizando registros y competencias evaluativas...
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modalOverlay);
        setTimeout(() => modalOverlay.classList.add('modal-open'), 10);

        const modalBody = modalOverlay.querySelector('.modal-view-body');

        const cerrarModal = () => {
            modalOverlay.classList.remove('modal-open');
            setTimeout(() => modalOverlay.remove(), 220);
        };

        modalOverlay.querySelector('.btn-modal-view-close').addEventListener('click', cerrarModal);
        modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) cerrarModal(); });

        // 2. Consulta transaccional de 4 fuentes de datos en paralelo
        try {
            const [resMatriculas, resNotas, resPeriodos, resCompetencias] = await Promise.all([
                // CORREGIDO: Aseguramos la selección de id_est tanto en la matrícula como en el objeto interno del estudiante
                supabaseClient.from('matriculas').select('id_est, estudiantes(id_est, apellido_paterno, apellido_materno, nombres)').eq('id_sec', idSec).eq('estado', 'ACTIVO'),
                supabaseClient.from('calificaciones').select('id_est, id_escala, id_periodo, id_competencia').eq('id_asignacion', idAsignacion),
                supabaseClient.from('periodos_evaluacion').select('id_periodo, nombre_periodo').order('fecha_inicio', { ascending: true }),
                supabaseClient.from('competencias').select('id_competencia, descripcion_competencia').eq('id_curso', idCurso).order('id_competencia', { ascending: true })
            ]);

            if (resMatriculas.error) throw resMatriculas.error;
            if (resNotas.error) throw resNotas.error;
            if (resPeriodos.error) throw resPeriodos.error;
            if (resCompetencias.error) throw resCompetencias.error;

            // CORREGIDO: Mapeo seguro utilizando un operador lógico de respaldo para el id_est
            const listaAlumnos = (resMatriculas.data || []).map(m => ({
                id_est: m.id_est || m.estudiantes?.id_est, 
                nombre_completo: `${m.estudiantes?.apellido_paterno || ''} ${m.estudiantes?.apellido_materno || ''}, ${m.estudiantes?.nombres || ''}`.toUpperCase()
            })).sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo));

            const periodos = resPeriodos.data || [];
            const notas = resNotas.data || [];
            const competencias = resCompetencias.data || [];

            if (listaAlumnos.length === 0) {
                modalBody.innerHTML = '<p style="text-align:center; color:#64748b;">No existen estudiantes matriculados en esta sección.</p>';
                return;
            }

            if (competencias.length === 0) {
                modalBody.innerHTML = '<p style="text-align:center; color:#64748b; padding:20px;">No se han configurado las competencias curriculares para este curso en la base de datos.</p>';
                return;
            }

            // 3. Renderizar la Sábana de Notas con cabecera de doble nivel (Matriz)
            let tableHtml = `
                <div style="overflow-x: auto; border: 1px solid #e2e8f0; border-radius: 10px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.01);">
                    <table style="width:100%; border-collapse:collapse; text-align:left; font-size:0.85rem;">
                        <thead>
                            <tr style="background:#f8fafc; border-bottom:1px solid #e2e8f0; color:#475569;">
                                <th rowspan="2" style="padding:12px; width:45px; text-align:center; border-right:1px solid #e2e8f0; font-weight:700;">N°</th>
                                <th rowspan="2" style="padding:12px; min-width:240px; border-right:1px solid #e2e8f0; font-weight:700;">Apellidos y Nombres</th>`;
            
            periodos.forEach(p => {
                tableHtml += `<th colspan="${competencias.length}" style="padding:10px; text-align:center; border-right:1px solid #e2e8f0; background:#f1f5f9; color:#0284c7; font-weight:700; font-size:0.8rem;">${p.nombre_periodo}</th>`;
            });

            tableHtml += `
                            </tr>
                            <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0; color:#64748b;">`;
            
            periodos.forEach(p => {
                competencias.forEach((comp, cIdx) => {
                    tableHtml += `<th style="padding:6px 4px; text-align:center; font-weight:700; font-size:0.72rem; border-right:1px solid #e2e8f0; background:#fafafa;" title="${comp.descripcion_competencia}">C${cIdx + 1}</th>`;
                });
            });

            tableHtml += `
                            </tr>
                        </thead>
                        <tbody>`;

            // Construcción de filas por estudiante
            listaAlumnos.forEach((alumno, index) => {
                tableHtml += `
                    <tr style="border-bottom:1px solid #f1f5f9; transition: background 0.15s;">
                        <td style="padding:8px; text-align:center; font-weight:bold; color:#94a3b8; border-right:1px solid #f1f5f9;">${index + 1}</td>
                        <td style="padding:8px; font-weight:600; color:#334155; border-right:1px solid #f1f5f9;">${alumno.nombre_completo}</td>`;

                // Mapeo cruzado exacto: Periodo ──> Competencia ──> Nota Alumno
                periodos.forEach(p => {
                    competencias.forEach(comp => {
                        // CORREGIDO: Se cambia '===' por '==' para evitar fallos de tipo String/Number
                        const notaReg = notas.find(n => 
                            n.id_est == alumno.id_est && 
                            n.id_periodo == p.id_periodo && 
                            n.id_competencia == comp.id_competencia
                        );
                        
                        tableHtml += `<td style="padding:6px 4px; text-align:center; vertical-align:middle; border-right:1px solid #f1f5f9;">`;
                        
                        if (notaReg && notaReg.id_escala) {
                            tableHtml += `<span class="badge-nota-view nota-${notaReg.id_escala.toLowerCase()}">${notaReg.id_escala}</span>`;
                        } else {
                            tableHtml += `<span class="sin-nota">─</span>`;
                        }
                        
                        tableHtml += `</td>`;
                    });
                });

                tableHtml += `</tr>`;
            });

            tableHtml += `
                        </tbody>
                    </table>
                </div>`;

            // 4. Inyección dinámica de Leyenda informativa de Competencias
            let leyendaHtml = `
                <div style="margin-top:20px; padding:15px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">
                    <h4 style="margin:0 0 10px 0; font-size:0.8rem; color:#475569; text-transform:uppercase; letter-spacing:0.5px; font-weight:700; display:flex; align-items:center; gap:6px;">
                        <span class="material-symbols-outlined" style="font-size:18px; color:#007bff;">info</span> Leyenda de Competencias del Curso
                    </h4>
                    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:10px; font-size:0.8rem; color:#475569;">`;

            competencias.forEach((comp, cIdx) => {
                leyendaHtml += `<div style="line-height:1.4;"><strong style="color:#0284c7;">C${cIdx + 1}:</strong> ${comp.descripcion_competencia}</div>`;
            });

            leyendaHtml += `
                    </div>
                </div>
                <div style="margin-top:15px; display:flex; align-items:center; gap:6px; color:#94a3b8; font-size:0.78rem; font-weight:600; justify-content: flex-end;">
                    <span class="material-symbols-outlined" style="font-size:15px;">lock</span> Cuadro oficial sincronizado en modo de solo lectura.
                </div>`;

            modalBody.innerHTML = tableHtml + leyendaHtml;

        } catch (err) {
            console.error("Error en modal de visualización:", err);
            modalBody.innerHTML = `<p style="color:red; text-align:center; font-weight:600; padding:20px;">Error al compilar la sábana histórica: ${err.message}</p>`;
        }
    }



    async function cargarDashboardPadre(idUsu) {
        const dashboardContainer = document.getElementById('dashboard-content');
        dashboardContainer.innerHTML = '<p>Consultando información de tus hijos...</p>';

        try {
            // 1. Buscamos a los hijos vinculados a este responsable
            const { data: hijos, error } = await supabaseClient
                .from('usuarios')
                .select(`
                    id_usu,
                    responsables!inner(
                        id_res,
                        estudiantes_responsables(
                            estudiantes(id_est, nombres, apellido_paterno)
                        )
                    )
                `)
                .eq('id_usu', idUsu)
                .single();

            if (error) throw error;

            const listaHijos = hijos.responsables[0].estudiantes_responsables;

            let html = '<div class="grid-cards">';
            
            // Para cada hijo, generamos una tarjeta de resumen
            for (let item of listaHijos) {
                const est = item.estudiantes;
                
                // Verificamos deuda usando la función RPC que creamos en SQL
                const { data: tieneDeuda } = await supabaseClient.rpc('fn_estudiante_tiene_deuda', { p_id_est: est.id_est });

                html += `
                    <div class="card shadow">
                        <div style="display:flex; justify-content:between; align-items:center;">
                            <h3>${est.nombres}</h3>
                            <span class="badge ${tieneDeuda ? 'bg-danger' : 'bg-success'}">
                                ${tieneDeuda ? 'Pago Pendiente' : 'Al día'}
                            </span>
                        </div>
                        <p>Resumen académico del mes</p>
                        <button class="btn-primary" style="width:100%; margin-top:10px;" onclick="verProgreso('${est.id_est}')">
                            Ver Libreta / Notas
                        </button>
                    </div>
                `;
            }
            
            html += '</div>';
            dashboardContainer.innerHTML = html;

        } catch (err) {
            dashboardContainer.innerHTML = '<p>Bienvenido. Selecciona una opción del menú para comenzar.</p>';
            console.error(err);
        }
    }

    function configurarMenuPorRol(idRol, permisosSlugs = []) {
        // 1. Restablecer y aplicar lógica estática heredada por roles generales
        if (idRol == 5) { // Responsable / Padre
            document.querySelectorAll('.role-docente').forEach(el => el.style.display = 'none');
            document.querySelectorAll('.role-admin').forEach(el => el.style.display = 'none');
            document.querySelectorAll('.role-estudiante').forEach(el => el.style.display = 'block');
        } else if (idRol == 4) { // Docente
            document.querySelectorAll('.role-estudiante').forEach(el => el.style.display = 'none');
            document.querySelectorAll('.role-admin').forEach(el => el.style.display = 'none');
            document.querySelectorAll('.role-docente').forEach(el => el.style.display = 'block');
        }

        // Identificar si es Administrador para el Bypass de seguridad
        const esAdmin = window.miRolUsuario === 'ADMINISTRADOR' || window.miRolUsuario === 'ADMIN';
        
        if (esAdmin) {
            document.querySelectorAll('.role-admin').forEach(el => el.style.display = 'block');
            document.querySelectorAll('.role-docente').forEach(el => el.style.display = 'block');
            document.querySelectorAll('.role-estudiante').forEach(el => el.style.display = 'none');
        }

        // -----------------------------------------------------------------
        // CONTROL DINÁMICO POR ACCESOS DE TABLA DE PERMISOS
        // -----------------------------------------------------------------
        const modulosProtegidos = ['marcar-asistencia', 'configuracion', 'evaluacion'];

        modulosProtegidos.forEach(slug => {
            const enlaceMenu = document.querySelector(`.nav-links a[onclick*="${slug}"]`);
            if (enlaceMenu) {
                const itemLista = enlaceMenu.closest('li');
                if (itemLista) {
                    if (permisosSlugs.includes(slug) || (esAdmin && slug === 'configuracion')) {
                        itemLista.style.display = ''; 
                    } else {
                        itemLista.style.display = 'none'; 
                    }
                }
            }
        });

        // =================================================================
        // NUEVO: CONTROL EXCLUSIVO PARA EL MÓDULO "VER SECCIÓN" (TUTORÍA)
        // =================================================================
        const enlaceVerSeccion = document.querySelector(`.nav-links a[onclick*="ver-seccion"]`);
        if (enlaceVerSeccion) {
            const itemListaVerSeccion = enlaceVerSeccion.closest('li');
            if (itemListaVerSeccion) {
                const tieneTutoriaAsignada = window.misSeccionesTutoria && window.misSeccionesTutoria.length > 0;

                // Se muestra únicamente si es Administrador O si es Tutor activo
                if (esAdmin || tieneTutoriaAsignada) {
                    itemListaVerSeccion.style.display = '';
                } else {
                    itemListaVerSeccion.style.display = 'none'; // Ocultado por completo
                }
            }
        }

        // --- NUEVO: CONTROL PARA EL MÓDULO "MI PROGRESO" (ADMIN / ESTUDIANTE) ---
        const enlaceProgreso = document.querySelector(`.nav-links a[onclick*="mi-progreso"]`);
        if (enlaceProgreso) {
            const itemListaProgreso = enlaceProgreso.closest('li');
            if (itemListaProgreso) {
                // Permitimos ver la opción si es Administrador (para buscar) o si es un estudiante/padre en el futuro
                if (esAdmin || idRol == 5) {
                    itemListaProgreso.style.display = '';
                } else {
                    itemListaProgreso.style.display = 'none';
                }
            }
        }
    }


    //===========================================================
    // Función para manejar las pestañas internas de Configuración
    async function openConfigTab(tabName) {
        // 1. Lógica visual: Ocultar contenidos y limpiar botones
        document.querySelectorAll('.config-tab-content').forEach(t => t.style.display = 'none');
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        
        // 2. Mostrar el contenedor correspondiente (tab-nombre)
        const targetTab = document.getElementById('tab-' + tabName);
        if (targetTab) {
            targetTab.style.display = 'block';
        }
        
        // 3. Marcar botón como activo
        if (event && event.currentTarget) {
            event.currentTarget.classList.add('active');
        }

        // ==========================================
        // LÓGICA ESPECÍFICA POR PESTAÑA
        // ==========================================

        // --- NUEVO: Interceptor de Seguridad y Carga de Permisos por Rol ---
        // --- CORREGIDO: Validación directa usando la variable global ya verificada ---
        if (tabName === 'permisos-man') {
            const rolActual = window.miRolUsuario || '';
            
            // Si no es administrador, bloqueamos el acceso de inmediato
            if (rolActual !== 'ADMINISTRADOR' && rolActual !== 'ADMIN') {
                alert("Acceso denegado: Esta sección requiere privilegios de Administrador.");
                return; // Corta la ejecución
            }

            // Si es administrador, cargamos la matriz de permisos directamente
            await inicializarModuloPermisos();
        }

    
        // --- CORRECCIÓN: Cargar selectores de asignación de cursos ---
        if (tabName === 'asignacion-man') {
            await cargarSelectsAsignacion();
        }

        // --- Gestión de Feriados ---
        if (tabName === 'feriados-man') {
            await cargarFeriados();
        }

        // --- Gestión de Horarios ---
        if (tabName === 'horarios') {
            listarHorarios();
        }

        // --- Usuarios: Listado ---
        if (tabName === 'usuarios-lista') {
            const selectRol = document.getElementById('filtro-user-rol');
            if (selectRol && selectRol.options.length <= 1) {
                await cargarRolesFiltro();
            }
            const selectAnioLista = document.getElementById('select-anio-migrar-lista');
            if (selectAnioLista && selectAnioLista.options.length <= 1) {
                await cargarAniosMigracion();
            }
            listarUsuarios();
        }
        
        // --- Usuarios: Registro Masivo ---
        if (tabName === 'usuarios-reg') {
            const selectAnioReg = document.getElementById('select-anio-migrar');
            if (selectAnioReg && selectAnioReg.options.length <= 1) {
                await cargarAniosMigracion();
            }
        }

        // --- Cursos ---
        if (tabName === 'cursos-man') {
            listarCursos();
        }
    }

    let personasPendientes = [];

    async function buscarPendientes() {
        const idAnio = document.getElementById('select-anio-migrar').value;
        const nivelSeleccionado = document.getElementById('select-nivel-migrar').value; // Capturamos el nivel
        const listaDiv = document.getElementById('lista-pendientes');
        const btnMigrar = document.getElementById('btn-migrar-todo');

        // Validación: Ahora pedimos ambos filtros
        if (!idAnio || !nivelSeleccionado) {
            alert("Por favor, seleccione el Año Académico y el Nivel.");
            return;
        }

        listaDiv.innerHTML = `<p style="color: blue;">Buscando alumnos de ${nivelSeleccionado}...</p>`;
        btnMigrar.style.display = 'none';

        try {
            const { data: usuariosExistentes } = await supabaseClient.from('usuarios').select('usuario');
            const dnisExistentes = new Set(usuariosExistentes.map(u => u.usuario));

            // Consulta con el nuevo filtro de Nivel aplicado a la tabla 'secciones'
            const { data, error } = await supabaseClient
                .from('matriculas')
                .select(`
                    id_est,
                    estudiantes (
                        dni, nombres, apellido_paterno, apellido_materno,
                        estudiantes_responsables!inner (
                            responsables (dni, nombres, apellido_paterno, apellido_materno)
                        )
                    ),
                    secciones!inner (
                        grado,
                        nombre_sec,
                        id_anio,
                        nivel
                    )
                `)
                .eq('secciones.id_anio', idAnio)
                .eq('secciones.nivel', nivelSeleccionado); // <-- FILTRO DE NIVEL AÑADIDO

            if (error) throw error;

            personasPendientes = data.map(m => {
                const est = m.estudiantes;
                const res = est?.estudiantes_responsables?.[0]?.responsables;
                const grado = m.secciones?.grado || 'N/A';
                const seccion = m.secciones?.nombre_sec || 'N/A';

                if (!est || !res) return null;

                const estValido = est.dni?.length >= 8 && !dnisExistentes.has(est.dni);
                const resValido = res.dni?.length >= 8;

                if (estValido && resValido) {
                    return {
                        est_dni: est.dni,
                        est_nombre: `${est.apellido_paterno} ${est.apellido_materno}, ${est.nombres}`,
                        res_dni: res.dni,
                        res_nombre: `${res.apellido_paterno} ${res.apellido_materno}, ${res.nombres}`,
                        res_tiene_cuenta: dnisExistentes.has(res.dni),
                        salon: `${grado} - ${seccion}`
                    };
                }
                return null;
            }).filter(item => item !== null);

            if (personasPendientes.length === 0) {
                listaDiv.innerHTML = `<div class="card" style="background:#fff3cd; padding:10px;">
                    No se encontraron registros pendientes en ${nivelSeleccionado} para este año.
                </div>`;
                return;
            }

            // 4. Dibujar la tabla
            let html = `
                <table class="tabla-app">
                    <thead>
                        <tr>
                            <th><input type="checkbox" id="check-all" onclick="toggleTodos(this)"></th>
                            <th>Grado/Sección</th>
                            <th>Estudiante (DNI)</th>
                            <th>Responsable (DNI)</th>
                            <th>Estado Responsable</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            personasPendientes.forEach((p, i) => {
                html += `
                    <tr>
                        <td><input type="checkbox" class="check-persona" value="${i}"></td>
                        <td><small>${p.salon}</small></td>
                        <td><b>${p.est_nombre}</b><br><small>${p.est_dni}</small></td>
                        <td>${p.res_nombre}<br><small>${p.res_dni}</small></td>
                        <td>${p.res_tiene_cuenta ? 
                            '<span style="color:green; font-weight:bold;">Cuenta Activa</span>' : 
                            '<span style="color:orange;">Pendiente de cuenta</span>'}</td>
                    </tr>
                `;
            });

            html += '</tbody></table>';
            listaDiv.innerHTML = html;
            btnMigrar.style.display = 'block';

            // Re-asignar eventos a los checkboxes
            document.querySelectorAll('.check-persona').forEach(cb => {
                cb.addEventListener('change', actualizarContadorSeleccionados);
            });
            
            actualizarContadorSeleccionados();

        } catch (err) {
            console.error("Error en buscarPendientes:", err.message);
            listaDiv.innerHTML = `<p style="color:red">Error: ${err.message}</p>`;
        }
    }

    // Función auxiliar para el checkbox maestro
    function toggleTodos(source) {
        const checkboxes = document.querySelectorAll('.check-persona');
        checkboxes.forEach(cb => {
            cb.checked = source.checked;
        });
        
        // Actualizar el contador después de marcar/desmarcar todos
        actualizarContadorSeleccionados();
    }

    function actualizarContadorSeleccionados() {
        const seleccionados = document.querySelectorAll('.check-persona:checked').length;
        const btnMigrar = document.getElementById('btn-migrar-todo');
        
        if (btnMigrar) {
            btnMigrar.innerHTML = `<span class="material-symbols-outlined">group_add</span> Registrar Seleccionados (${seleccionados})`;
            
            // Opcional: Deshabilitar el botón si no hay nadie seleccionado
            btnMigrar.disabled = (seleccionados === 0);
        }
    }

    async function ejecutarMigracionMasiva() {
        const seleccionados = document.querySelectorAll('.check-persona:checked');
        if (seleccionados.length === 0) {
            alert("Seleccione al menos un registro.");
            return;
        }

        const btn = document.getElementById('btn-migrar-todo');
        btn.disabled = true;
        btn.innerText = "Procesando registros...";

        let exitos = 0;
        let errores = 0;

        // Usamos un Set para no intentar registrar al mismo padre dos veces en el mismo bucle
        const padresProcesados = new Set();

        for (let cb of seleccionados) {
            const data = personasPendientes[cb.value];

            try {
                // 1. REGISTRAR AL RESPONSABLE (Si no tiene cuenta y no lo hemos procesado ya)
                if (!data.res_tiene_cuenta && !padresProcesados.has(data.res_dni)) {
                    await supabaseClient.functions.invoke('registro-masivo', {
                        body: { 
                            action: 'create', // <--- NUEVO
                            dni: data.res_dni, 
                            nombre: data.res_nombre, 
                            id_rol: 5 
                        }
                    });
                    padresProcesados.add(data.res_dni);
                }

                // 2. REGISTRAR AL ESTUDIANTE
                const { error: errorEst } = await supabaseClient.functions.invoke('registro-masivo', {
                    body: { 
                        action: 'create', // <--- NUEVO
                        dni: data.est_dni, 
                        nombre: data.est_nombre, 
                        id_rol: 6 
                    }
                });

                if (errorEst) throw errorEst;
                exitos++;

            } catch (err) {
                console.error(`Error en DNI ${data.est_dni}:`, err.message);
                errores++;
            }
        }

        alert(`Sincronización terminada.\nEstudiantes creados: ${exitos}\nErrores: ${errores}`);
        btn.disabled = false;
        btn.innerText = "Registrar Seleccionados";
        
        if (typeof buscarPendientes === 'function') {
            buscarPendientes(); // Recargar lista para que los que ya tienen cuenta desaparezcan
        }
    }


    //=====================================================================
    // Registro Manual

    // Registro Manual
    const formManual = document.getElementById('form-registro-manual');

    if (formManual) {
        formManual.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const dni = document.getElementById('reg-dni').value.trim();
            const nombre = document.getElementById('reg-nombre').value.trim();
            const rol = document.getElementById('reg-rol').value;
            const msgDiv = document.getElementById('reg-manual-msg');

            if (dni.length < 8) {
                msgDiv.innerText = "El DNI debe tener al menos 8 dígitos.";
                msgDiv.style.color = "red";
                return;
            }

            msgDiv.innerText = "Procesando registro...";
            msgDiv.style.color = "blue";

            try {
                // Invocamos la Edge Function con el campo 'action'
                const { data, error } = await supabaseClient.functions.invoke('registro-masivo', {
                    body: { 
                        action: 'create', // <--- ESTA ES LA LÍNEA CLAVE
                        dni: dni, 
                        nombre: nombre, 
                        id_rol: parseInt(rol) 
                    }
                });

                if (error) throw error;

                msgDiv.innerText = "¡Usuario registrado con éxito! Contraseña: " + dni;
                msgDiv.style.color = "green";
                formManual.reset();

                // Opcional: Si tienes abierta la pestaña de listado, actualízala
                if (typeof listarUsuarios === 'function') {
                    listarUsuarios();
                }

            } catch (error) {
                console.error("Error en registro manual:", error.message);
                msgDiv.innerText = "Error: " + error.message;
                msgDiv.style.color = "red";
            }
        });
    }
    
    
    
    //=====================================================================

    async function confirmarActivacion(idPeriodo, nombre) {
        if (confirm(`¿Estás seguro de activar el ${nombre}? Esto cerrará cualquier otro periodo abierto.`)) {
            try {
                const { error } = await supabaseClient.rpc('fn_activar_periodo', { 
                    p_id_periodo: idPeriodo 
                });

                if (error) throw error;

                alert("¡Periodo activado con éxito!");
                cargarListaPeriodos(); // Refrescamos la tabla

            } catch (err) {
                alert("Error al activar: " + err.message);
            }
        }
    }


    //=====================================================================
    async function cargarRolesFiltro() {
        const select = document.getElementById('filtro-user-rol');
        if (!select) return;

        try {
            const { data: roles, error } = await supabaseClient
                .from('roles')
                .select('*')
                .order('nombre_rol', { ascending: true });

            if (error) throw error;

            select.innerHTML = '<option value="">Todos los Roles</option>';
            roles.forEach(rol => {
                const opt = document.createElement('option');
                opt.value = rol.id_rol;
                opt.textContent = rol.nombre_rol;
                select.appendChild(opt);
            });
        } catch (err) {
            console.error("Error al cargar roles:", err.message);
        }
    }
    
    async function listarUsuarios() {
        const container = document.getElementById('tabla-usuarios-container');
        const idAnio = document.getElementById('select-anio-migrar-lista').value;
        const rolFiltro = document.getElementById('filtro-user-rol').value;
        const nivelFiltro = document.getElementById('filtro-user-nivel').value;
        const gradoFiltro = document.getElementById('filtro-user-grado').value;
        const busqueda = document.getElementById('buscar-usuario').value.toLowerCase().trim();

        container.innerHTML = '<p>Cruzando datos de familia y academia...</p>';

        try {
            // 1. Mapeo Académico Complejo (Estudiantes y sus Padres)
            let mapaAcademico = {}; // Estructura: { "DNI": [ {nivel, grado}, ... ] }

            if (idAnio) {
                const { data: matData } = await supabaseClient
                    .from('matriculas')
                    .select(`
                        estudiantes (
                            dni,
                            estudiantes_responsables ( responsables (dni) )
                        ),
                        secciones!inner ( nivel, grado, id_anio, nombre_sec )
                    `)
                    .eq('secciones.id_anio', idAnio);

                matData?.forEach(m => {
                    const info = {
                        nivel: m.secciones.nivel,
                        grado: m.secciones.grado.replace('°', '').trim(),
                        seccion: m.secciones.nombre_sec
                    };

                    // Vincular al Estudiante
                    const sDni = m.estudiantes.dni.toString().trim();
                    if (!mapaAcademico[sDni]) mapaAcademico[sDni] = [];
                    mapaAcademico[sDni].push(info);

                    // Vincular a sus Responsables
                    m.estudiantes.estudiantes_responsables?.forEach(rel => {
                        const rDni = rel.responsables.dni.toString().trim();
                        if (!mapaAcademico[rDni]) mapaAcademico[rDni] = [];
                        // Evitamos duplicar el mismo salón para el padre si ya se agregó por un hermano en el mismo salón
                        const yaExiste = mapaAcademico[rDni].some(x => x.nivel === info.nivel && x.grado === info.grado);
                        if (!yaExiste) mapaAcademico[rDni].push(info);
                    });
                });
            }

            // 2. Obtener Usuarios
            const { data: usuarios, error } = await supabaseClient
                .from('usuarios')
                .select(`*, roles:id_rol(nombre_rol)`)
                .order('nombre_completo', { ascending: true });

            if (error) throw error;

            // 3. Aplicar Filtros
            const usuariosFiltrados = usuarios.filter(u => {
                const dniU = u.usuario.toString().trim();
                const salones = mapaAcademico[dniU] || []; // Array de salones vinculados

                const coincideBusqueda = u.nombre_completo.toLowerCase().includes(busqueda) || dniU.includes(busqueda);
                const coincideRol = rolFiltro === "" || u.id_rol.toString() === rolFiltro;
                
                // Un usuario coincide con nivel/grado si AL MENOS UNO de sus salones vinculados coincide
                const coincideNivel = nivelFiltro === "" || salones.some(s => s.nivel === nivelFiltro);
                const coincideGrado = gradoFiltro === "" || salones.some(s => s.grado === gradoFiltro);

                return coincideBusqueda && coincideRol && coincideNivel && coincideGrado;
            });

            // 4. Dibujar Tabla
            dibujarTablaFinal(usuariosFiltrados, mapaAcademico, container);

        } catch (err) {
            console.error(err);
            container.innerHTML = '<p style="color:red">Error al cargar listado.</p>';
        }
    }

    function dibujarTablaFinal(usuarios, mapa, container) {
        if (usuarios.length === 0) {
            container.innerHTML = '<p>No se encontraron resultados.</p>';
            return;
        }

        let html = `<table class="tabla-app"><thead><tr>
            <th>DNI / Usuario</th>
            <th>Nombre Completo</th>
            <th>Rol</th>
            <th>Ubicación (Hijos/Propio)</th>
            <th>Estado</th>
            <th>Acciones</th>
        </tr></thead><tbody>`;

        usuarios.forEach(u => {
            const dniU = u.usuario.toString().trim();
            const salones = mapa[dniU] || [];
            
            const btnColor = u.activo ? 'btn-warning' : 'btn-success';
            const btnText = u.activo ? 'Deshabilitar' : 'Habilitar';
            const statusLabel = u.activo ? '<span class="badge-success">Activo</span>' : '<span class="badge-error">Inactivo</span>';

            const nombreLimpio = u.nombre_completo.replace(/'/g, "\\'");
            const rolNombre = u.roles?.nombre_rol || 'N/A';
            
            let infoAcadQR = "";
            if (u.id_rol === 6 && salones.length > 0) {
                const s = salones[0];
                infoAcadQR = `${s.nivel} - ${s.grado}° ${s.seccion}`;
            }

            let ubicacionHtml = salones.length > 0 
                ? salones.map(s => `<div class="badge-info">${s.nivel} ${s.grado}°</div>`).join('')
                : '<span style="color:gray">Personal / Externo</span>';

            html += `
                <tr>
                    <td><b>${dniU}</b></td>
                    <td>${u.nombre_completo}</td>
                    <td><small>${u.roles?.nombre_rol || 'N/A'}</small></td>
                    <td>${ubicacionHtml}</td>
                    <td>${statusLabel}</td>
                    <td style="display:flex; gap:5px;">
                        <button class="btn-primary btn-sm" 
                            onclick="verQRUsuario('${u.auth_id}', '${nombreLimpio}', '${rolNombre}', '${infoAcadQR}')" 
                            title="Ver QR">
                            <span class="material-symbols-outlined" style="font-size:16px;">qr_code_2</span>
                        </button>

                        <button class="btn-sm ${btnColor}" 
                            onclick="cambiarEstadoUsuario('${u.auth_id}', ${!u.activo})">
                            ${btnText}
                        </button>

                        <button class="btn-primary btn-sm" style="background-color: #64748b; border-color: #64748b;"
                            onclick="modificarPasswordUsuario('${u.auth_id}', '${dniU}', '${nombreLimpio}')" 
                            title="Modificar Contraseña">
                            <span class="material-symbols-outlined" style="font-size:16px;">lock_reset</span>
                        </button>

                        <button class="btn-error btn-sm" onclick="eliminarUsuario('${u.auth_id}', '${u.nombre_completo}')">
                            <span class="material-symbols-outlined" style="font-size:16px;">delete</span>
                        </button>
                    </td>
                </tr>`;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    

    // FUNCIONES DE ACCIÓN
    async function cambiarEstadoUsuario(authId, nuevoEstado) {
        if (!confirm(`¿Desea ${nuevoEstado ? 'habilitar' : 'deshabilitar'} este usuario?`)) return;

        const { error } = await supabaseClient.functions.invoke('registro-masivo', {
            body: { action: 'toggle_status', auth_id: authId, activo: nuevoEstado }
        });

        if (error) alert("Error: " + error.message);
        else listarUsuarios();
    }

    async function eliminarUsuario(authId, nombre) {
        if (!confirm(`¿Está seguro de ELIMINAR permanentemente a ${nombre}? Esta acción no se puede deshacer.`)) return;

        const { error } = await supabaseClient.functions.invoke('registro-masivo', {
            body: { action: 'delete', auth_id: authId }
        });

        if (error) alert("Error: " + error.message);
        else listarUsuarios();
    }





    //============================================================================
    function verQRUsuario(authId, nombre, rol, infoAcad) {
        const modal = document.getElementById('modal-qr');
        const container = document.getElementById('qrcode-container');
        
        container.innerHTML = "";
        document.getElementById('qr-nombre').innerText = nombre;
        document.getElementById('qr-rol').innerText = rol;

        // Si hay info académica (es estudiante), le damos formato bonito
        if (infoAcad) {
            // Separamos el nivel/grado de la sección para ponerle comillas solo a la letra
            const partes = infoAcad.split(' '); 
            const seccion = partes.pop(); // La última palabra (la letra)
            const resto = partes.join(' '); // El resto (Nivel - Grado°)
            document.getElementById('qr-info-acad').innerText = `${resto} "${seccion}"`;
        } else {
            document.getElementById('qr-info-acad').innerText = "";
        }

        new QRCode(container, {
            text: authId,
            width: 180,
            height: 180,
            correctLevel : QRCode.CorrectLevel.H
        });

        modal.style.display = "flex";
    }

    function cerrarModalQR() {
        document.getElementById('modal-qr').style.display = "none";
    }


    //===================================================================================
    // Mostrar u ocultar campos según el tipo de grupo
    function toggleInputsGrupo() {
        const tipo = document.getElementById('hor-tipo-grupo').value;
        document.getElementById('group-rol').style.display = tipo === 'ROL' ? 'block' : 'none';
        document.getElementById('group-grado').style.display = tipo === 'GRADO_NIVEL' ? 'block' : 'none';
        
        if (tipo === 'GRADO_NIVEL') {
            const div = document.getElementById('checks-grados');
            const grados = ['1°', '2°', '3°', '4°', '5°', '6°'];
            div.innerHTML = grados.map(g => `<label><input type="checkbox" value="${g}"> ${g}</label>`).join('');
        }
    }

    // Guardar Horario
    document.getElementById('form-nuevo-horario')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const tipo = document.getElementById('hor-tipo-grupo').value;
        let valorGrupo = {};

        if (tipo === 'ROL') {
            const roles = Array.from(document.querySelectorAll('#group-rol input:checked')).map(i => parseInt(i.value));
            // Mapeo especial para el grupo unificado (4,7,3)
            if (roles.includes(4)) roles.push(7, 3);
            valorGrupo = { roles: [...new Set(roles)] };
        } else {
            const grados = Array.from(document.querySelectorAll('#checks-grados input:checked')).map(i => i.value);
            valorGrupo = { nivel: document.getElementById('hor-nivel').value, grados: grados };
        }

        const nuevoHorario = {
            nombre_horario: document.getElementById('hor-nombre').value,
            tipo_grupo: tipo,
            valor_grupo: valorGrupo,
            hora_entrada: document.getElementById('hor-entrada').value,
            tolerancia_minutos: parseInt(document.getElementById('hor-tolerancia').value),
            hora_salida: document.getElementById('hor-salida').value,
            fecha_inicio: document.getElementById('hor-fecha-inicio').value
        };

        const { error } = await supabaseClient.from('config_horarios').insert([nuevoHorario]);

        if (error) alert("Error: " + error.message);
        else {
            alert("Horario guardado correctamente");
            listarHorarios();
            e.target.reset();
        }
    });

    // Listar Horarios
    async function listarHorarios() {
        const container = document.getElementById('lista-horarios-vigentes');
        const { data: horarios, error } = await supabaseClient
            .from('config_horarios')
            .select('*')
            .order('fecha_inicio', { ascending: false });

        if (error) return;

        container.innerHTML = horarios.map(h => `
            <div class="item-horario" style="padding: 10px; border: 1px solid #eee; margin-bottom: 8px; border-radius: 5px;">
                <div style="display: flex; justify-content: space-between;">
                    <strong>${h.nombre_horario}</strong>
                    <span class="badge-info">${h.fecha_inicio}</span>
                </div>
                <p style="font-size: 0.85rem; margin: 5px 0;">
                    Entrada: <b>${h.hora_entrada}</b> (Tol: ${h.tolerancia_minutos}m) | Salida: <b>${h.hora_salida}</b>
                </p>
                <small style="color: #666;">Grupo: ${h.tipo_grupo === 'ROL' ? 'Roles: ' + h.valor_grupo.roles.join(',') : h.valor_grupo.nivel + ' (' + h.valor_grupo.grados.join(',') + ')'}</small>
            </div>
        `).join('') || '<p>No hay horarios configurados.</p>';
    }

    async function obtenerHorarioAplicable(idUsu, idRol, dni) {
        const hoy = new Date().toISOString().split('T')[0];
        
        // 1. Obtener todos los horarios activos para la fecha actual
        const { data: horarios } = await supabaseClient
            .from('config_horarios')
            .select('*')
            .eq('activo', true)
            .lte('fecha_inicio', hoy)
            .order('fecha_inicio', { ascending: false });

        if (!horarios || horarios.length === 0) return null;

        // 2. Si es Estudiante (Rol 6), buscar su grado/nivel actual
        let infoEstudiante = null;
        if (idRol === 6) {
            const { data: mat } = await supabaseClient
                .from('matriculas')
                .select('secciones(nivel, grado)')
                .eq('id_est', (await supabaseClient.from('estudiantes').select('id_est').eq('dni', dni).single()).data?.id_est)
                .single();
            infoEstudiante = mat?.secciones;
        }

        // 3. Filtrar el horario que coincida con el usuario
        return horarios.find(h => {
            if (h.tipo_grupo === 'ROL') {
                return h.valor_grupo.roles.includes(idRol);
            } else if (h.tipo_grupo === 'GRADO_NIVEL' && infoEstudiante) {
                return h.valor_grupo.nivel === infoEstudiante.nivel && 
                    h.valor_grupo.grados.includes(infoEstudiante.grado);
            }
            return false;
        });
    }


    //==========VER ASISTENCIA POR SECCIÓN=========================================================
    // 1. Manejo de Filtros Encadenados
    // CORREGIDO: Se transforma en ASYNC para consultar los grados asignados en la BD
    async function cargarGradosReporte() {
        const nivel = document.getElementById('rep-nivel').value;
        const gradoSelect = document.getElementById('rep-grado');
        gradoSelect.innerHTML = '<option value="">Seleccione...</option>';
        
        if (!nivel) return;

        // Detectar si el usuario tiene rol de Administrador
        const esAdmin = window.miRolUsuario === 'ADMINISTRADOR' || window.miRolUsuario === 'ADMIN';
        let gradosToShow = [];

        if (esAdmin) {
            // Si es Administrador, cargamos todos los grados por defecto de la institución
            gradosToShow = nivel === 'Primaria' ? ['1°', '2°', '3°', '4°', '5°', '6°'] : ['1°', '2°', '3°', '4°', '5°'];
        } else {
            try {
                // Si es Docente, consultamos a Supabase qué grados de ese nivel pertenecen a sus secciones de tutoría
                const { data, error } = await supabaseClient
                    .from('secciones')
                    .select('grado')
                    .eq('nivel', nivel)
                    .in('id_sec', window.misSeccionesTutoria || []);

                if (error) throw error;

                if (data) {
                    // Filtramos para obtener una lista de grados únicos asignados (Ej: ['3°', '5°'])
                    gradosToShow = [...new Set(data.map(s => s.grado))].sort();
                }
            } catch (err) {
                console.error("Error al filtrar grados por tutoría:", err.message);
                return;
            }
        }

        // Poblar el selector de grados con el lote filtrado
        gradosToShow.forEach(g => {
            const opt = document.createElement('option');
            opt.value = g;
            opt.textContent = g;
            gradoSelect.appendChild(opt);
        });
    }

    // CORREGIDO: Filtra las secciones en la consulta de Supabase si no es Admin
    async function cargarSeccionesReporte() {
        const nivel = document.getElementById('rep-nivel').value;
        const grado = document.getElementById('rep-grado').value;
        const secSelect = document.getElementById('rep-seccion');
        
        if (!nivel || !grado) {
            secSelect.innerHTML = '<option value="">Seleccione...</option>';
            return;
        }

        // Detectar si el usuario tiene rol de Administrador
        const esAdmin = window.miRolUsuario === 'ADMINISTRADOR' || window.miRolUsuario === 'ADMIN';

        // Construimos la consulta base filtrando por nivel y grado
        let query = supabaseClient
            .from('secciones')
            .select('id_sec, nombre_sec')
            .eq('nivel', nivel)
            .eq('grado', grado);

        // RESTICCIÓN CRÍTICA: Si NO es administrador, filtramos estrictamente por sus IDs de sección asignados
        if (!esAdmin) {
            query = query.in('id_sec', window.misSeccionesTutoria || []);
        }

        const { data, error } = await query;

        if (error) {
            console.error("Error al cargar secciones filtradas:", error.message);
            return;
        }

        secSelect.innerHTML = '<option value="">Seleccione...</option>';
        data?.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id_sec;
            opt.textContent = s.nombre_sec;
            secSelect.appendChild(opt);
        });
    }

    function toggleFechaFiltro() {
        const vista = document.getElementById('rep-vista').value;
        const colFecha = document.getElementById('col-fecha');
        const labelFecha = colFecha.querySelector('label');

        // Aseguramos que la opacidad sea siempre 1 (Eliminamos el efecto de "deshabilitado")
        colFecha.style.opacity = '1';
        colFecha.style.pointerEvents = 'auto'; // Garantiza que los clics funcionen

        // Opcional: Cambiar el texto para que el usuario sepa qué está navegando
        if (vista === 'dia') {
            labelFecha.innerHTML = '<span class="material-symbols-outlined">calendar_today</span> Fecha Exacta';
        } else if (vista === 'semana') {
            labelFecha.innerHTML = '<span class="material-symbols-outlined">date_range</span> Navegar por Semanas';
        } else {
            labelFecha.innerHTML = '<span class="material-symbols-outlined">calendar_month</span> Navegar por Meses';
        }
    }

    //VARIABLE GLOBAL
    let datosReporteActual = null; // Guardará estudiantes, asistencias y fechas
        
    // 2. Generación del Reporte Matrix
    async function generarReporteAsistencia() {
        const idSec = document.getElementById('rep-seccion').value;
        const vista = document.getElementById('rep-vista').value;
        const fechaBase = document.getElementById('rep-fecha-busqueda').value;
        const container = document.getElementById('reporte-asistencia-container');
        const btnImprimir = document.getElementById('cont-boton-imprimir'); // Capturamos el botón

        if (!idSec || !fechaBase) return alert("Seleccione sección y período");
        
        container.innerHTML = "<div class='loader'>Procesando reporte...</div>";
        btnImprimir.style.display = 'none'; // Lo ocultamos al empezar

        try {
            // ... (Lógica de fechas que ya tienes) ...
            const d = new Date(fechaBase + "T00:00:00");
            let fechaInicio, fechaFin;
            if (vista === 'dia') { fechaInicio = fechaFin = fechaBase; }
            else if (vista === 'semana') {
                const day = d.getDay();
                const diff = d.getDate() - (day === 0 ? 6 : day - 1);
                fechaInicio = new Date(d.setDate(diff)).toISOString().split('T')[0];
                fechaFin = new Date(d.setDate(diff + 6)).toISOString().split('T')[0];
            } else {
                fechaInicio = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
                fechaFin = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
            }

            // 1. Obtener Estudiantes ACTIVOS y Ordenados
            const { data: matriculados } = await supabaseClient
                .from('matriculas').select('estudiantes(id_est, dni, apellido_paterno, apellido_materno, nombres)')
                .eq('id_sec', idSec).eq('estado', 'ACTIVO');

            let estudiantes = matriculados.map(m => ({
                id_est: m.estudiantes.id_est,
                dni: m.estudiantes.dni,
                nombre_completo: `${m.estudiantes.apellido_paterno} ${m.estudiantes.apellido_materno}, ${m.estudiantes.nombres}`
            })).sort((a,b) => a.nombre_completo.localeCompare(b.nombre_completo));

            // 2. Obtener Auth IDs y Feriados
            const dnis = estudiantes.map(e => e.dni.toString());
            const [resUsu, resFer] = await Promise.all([
                supabaseClient.from('usuarios').select('usuario, auth_id').in('usuario', dnis),
                supabaseClient.from('feriados').select('fecha, descripcion').gte('fecha', fechaInicio).lte('fecha', fechaFin)
            ]);

            estudiantes.forEach(e => e.auth_id = resUsu.data.find(u => u.usuario == e.dni)?.auth_id);
            const listaFeriados = resFer.data || [];

            // 3. Obtener Asistencias
            const ids = estudiantes.map(e => e.auth_id).filter(i => i);
            const { data: asistencias } = await supabaseClient.from('asistencia')
                .select('user_auth_id, fecha, estado').in('user_auth_id', ids)
                .gte('fecha', fechaInicio).lte('fecha', fechaFin);

            // 4. Guardar datos en la variable global para imprimir
            datosReporteActual = { 
                estudiantes, 
                asistencias, 
                feriados: listaFeriados, 
                fechaInicio, 
                fechaFin, 
                filtros: { 
                    nivel: document.getElementById('rep-nivel').value,
                    grado: document.getElementById('rep-grado').value,
                    seccion: document.getElementById('rep-seccion').options[document.getElementById('rep-seccion').selectedIndex].text
                }
            };

            // 5. MOSTRAR BOTÓN Y DIBUJAR TABLA
            btnImprimir.style.display = 'block'; 
            dibujarTablaReporte(estudiantes, asistencias, fechaInicio, fechaFin, listaFeriados);

        } catch (err) {
            console.error("Error:", err);
            container.innerHTML = "<p style='color:red;'>Error al cargar los datos.</p>";
            btnImprimir.style.display = 'none';
        }
    }


    // IMPRIMIR REPORTE ============================
    function imprimirReporte() {
        if (!datosReporteActual) return alert("No hay datos");

        const { estudiantes, asistencias, feriados, fechaInicio, fechaFin, filtros } = datosReporteActual;
        const fechasFeriados = feriados.map(f => f.fecha);
        const meses = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
        const diasLetra = ["D", "L", "M", "M", "J", "V", "S"];

        const fechas = [];
        let actual = new Date(fechaInicio + "T00:00:00");
        const tope = new Date(fechaFin + "T00:00:00");
        while (actual <= tope) {
            if (actual.getDay() !== 0 && actual.getDay() !== 6) fechas.push(new Date(actual));
            actual.setDate(actual.getDate() + 1);
        }

        const nombreMes = meses[new Date(fechaInicio + "T00:00:00").getMonth()];
        const anio = new Date(fechaInicio + "T00:00:00").getFullYear();

        let globalP = 0, globalT = 0, globalF = 0;

        let htmlPrint = `
        <html>
        <head>
            <style>
                @page { size: A4 landscape; margin: 1.5cm 1.5cm 0.5cm 1.5cm; }
                body { font-family: sans-serif; font-size: 7.5pt; color: #333; margin: 0; }
                
                /* Títulos y Metadatos */
                .header-container { text-align: center; margin-bottom: 11px; }
                .header-container h2 { margin: 0; font-size: 9pt; color: #0056b3; text-transform: uppercase; }
                
                .info-bar { 
                    display: flex; justify-content: space-between; 
                    background: #f0f7ff; border-bottom: 2px solid #007bff;
                    padding: 4px 10px; margin-bottom: 10px; font-weight: bold; font-size: 8pt;
                }

                table { width: 100%; border-collapse: collapse; table-layout: fixed; }
                th, td { border: 1px solid #b3d7ff; text-align: center; padding: 2px 1px; line-height: 0.8; }
                
                .header-row { background: #007bff; color: white; font-size: 10pt;}
                
                /* Nombre Estudiante: Mayúsculas y Corte */
                .col-nombre { 
                    width: 200px; text-align: left; padding-left: 5px;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                    text-transform: uppercase; font-weight: 400; font-size: 8pt;
                }
                
                .col-fecha { width: 16px; font-size: 9pt;}
                /* Clase para los números de las fechas en el encabezado */
                .col-numero-fecha { 
                    font-size: 9pt !important; 
                    font-weight: bold;
                    color: #0056b3; 
                }
                .col-sum { width: 16px; font-weight: bold; background: #8dbae7; font-size: 9pt;}
                .valor-sum {font-size: 10pt !important; font-weight: bold;}

                /* Estados con ajuste de impresión */
                .feriado { background: #eee !important; color: #999; -webkit-print-color-adjust: exact; }
                .total-row { background: #1e293b !important; color: white !important; -webkit-print-color-adjust: exact; font-weight: bold; font-size: 9pt;}
                .P { background: #d4edda !important; -webkit-print-color-adjust: exact; font-weight: bold; font-size: 9pt;}
                .T { background: #fff3cd !important; -webkit-print-color-adjust: exact; font-weight: bold; font-size: 9pt;}
                .F { background: #f8d7da !important; -webkit-print-color-adjust: exact; font-weight: bold; font-size: 9pt;}
                
                tr:nth-child(even):not(.total-row) { background: #fafafa; }
            </style>
        </head>
        <body>
            <div class="header-container">
                <h2>REGISTRO AUXILIAR DE ASISTENCIA - ${nombreMes} ${anio}</h2>
            </div>
            
            <div class="info-bar">
                <span>NIVEL: ${filtros.nivel}</span>
                <span>GRADO: ${filtros.grado}</span>
                <span>SECCIÓN: ${filtros.seccion}</span>
            </div>

            <table>
                <thead>
                    <tr class="header-row">
                        <th rowspan="2" class="col-nombre">ESTUDIANTE</th>
                        ${fechas.map(f => `<th class="col-fecha">${diasLetra[f.getDay()]}</th>`).join('')}
                        <th rowspan="2" class="col-sum">P</th>
                        <th rowspan="2" class="col-sum">T</th>
                        <th rowspan="2" class="col-sum">F</th>
                    </tr>
                    <tr style="background:#e7f1ff; color:#0056b3;">
                        ${fechas.map(f => `<th class="col-numero-fecha">${f.getDate()}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${estudiantes.map(est => {
                        let pR=0, tR=0, fR=0;
                        const celdas = fechas.map(f => {
                            const fStr = f.toISOString().split('T')[0];
                            const esFer = fechasFeriados.includes(fStr);
                            const reg = asistencias.find(a => a.user_auth_id === est.auth_id && a.fecha === fStr);
                            
                            if (esFer) return `<td class="feriado">H</td>`;
                            if (reg) {
                                const l = reg.estado.charAt(0);
                                if(l==='P') { pR++; globalP++; }
                                if(l==='T') { tR++; globalT++; }
                                if(l==='F') { fR++; globalF++; }
                                return `<td class="${l}">${l}</td>`;
                            }
                            return `<td>-</td>`;
                        }).join('');

                        return `
                        <tr>
                            <td class="col-nombre">${est.nombre_completo}</td>
                            ${celdas}
                            <td class="valor-sum" style="background:#f0fdf4;">${pR}</td>
                            <td class="valor-sum" style="background:#fffbeb;">${tR}</td>
                            <td class="valor-sum" style="background:#fef2f2;">${fR}</td>
                        </tr>`;
                    }).join('')}
                    
                    <tr class="total-row">
                        <td class="col-nombre" style="text-align: right; padding-right:10px;">TOTAL GENERAL</td>
                        ${fechas.map(f => {
                            const fStr = f.toISOString().split('T')[0];
                            if (fechasFeriados.includes(fStr)) return `<td>-</td>`;
                            const totalDia = asistencias.filter(a => a.fecha === fStr && (a.estado === 'PRESENTE' || a.estado === 'TARDANZA')).length;
                            return `<td style="color:#38bdf8;">${totalDia}</td>`;
                        }).join('')}
                        <td style="color:#4ade80;">${globalP}</td>
                        <td style="color:#fbbf24;">${globalT}</td>
                        <td style="color:#f87171;">${globalF}</td>
                    </tr>
                </tbody>
            </table>
        </body>
        </html>`;

        const v = window.open('', '_blank');
        v.document.write(htmlPrint);
        v.document.close();
        v.onload = () => v.print();
    }


    // --- FUNCION DE NAVEGACIÓN ---
    function navegarPeriodo(direccion) {
        const inputFecha = document.getElementById('rep-fecha-busqueda');
        const vista = document.getElementById('rep-vista').value;
        let fecha = new Date(inputFecha.value + "T00:00:00");

        if (isNaN(fecha.getTime())) fecha = new Date();

        if (vista === 'dia') {
            fecha.setDate(fecha.getDate() + direccion);
        } else if (vista === 'semana') {
            fecha.setDate(fecha.getDate() + (direccion * 7));
        } else if (vista === 'mes') {
            fecha.setMonth(fecha.getMonth() + direccion);
        }

        inputFecha.value = fecha.toISOString().split('T')[0];
        generarReporteAsistencia(); // Recargar reporte automáticamente
    }

    // --- DIBUJAR TABLA (VERSION L-V CON DOBLE CABECERA) ---
    function dibujarTablaReporte(estudiantes, asistencias, inicio, fin, feriados = []) {
        const container = document.getElementById('reporte-asistencia-container');
        const meses = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
        const diasLetra = ["D", "L", "M", "M", "J", "V", "S"];
        
        const fechas = [];
        let actual = new Date(inicio + "T00:00:00");
        const tope = new Date(fin + "T00:00:00");
        while(actual <= tope) {
            if (actual.getDay() !== 0 && actual.getDay() !== 6) fechas.push(new Date(actual));
            actual.setDate(actual.getDate() + 1);
        }

        const dRef = new Date(inicio + "T00:00:00");
        const headerTitle = `${meses[dRef.getMonth()]} ${dRef.getFullYear()}`;
        
        // Si feriados es undefined, el "[]" evita que el código falle
        const fechasFeriados = feriados ? feriados.map(f => f.fecha) : [];

        let globalP = 0, globalT = 0, globalF = 0;

        let html = `
            <div class="report-month-header">${headerTitle}</div>
            <div class="matrix-scroll">
            <table class="tabla-app reporte-matrix">
                <thead>
                    <tr>
                        <th rowspan="2" class="sticky-col">ESTUDIANTE</th>
                        ${fechas.map(f => {
                            const fStr = f.toISOString().split('T')[0];
                            const esFeriado = fechasFeriados.includes(fStr);
                            return `<th class="header-day-letter ${esFeriado ? 'col-feriado' : ''}">${diasLetra[f.getDay()]}</th>`;
                        }).join('')}
                        <th rowspan="2" class="header-summary">P</th>
                        <th rowspan="2" class="header-summary">T</th>
                        <th rowspan="2" class="header-summary">F</th>
                    </tr>
                    <tr>
                        ${fechas.map(f => {
                            const fStr = f.toISOString().split('T')[0];
                            const esFeriado = fechasFeriados.includes(fStr);
                            return `<th class="header-day-number ${esFeriado ? 'col-feriado' : ''}">${f.getDate()}</th>`;
                        }).join('')}
                    </tr>
                </thead>
                <tbody>`;

        estudiantes.forEach(est => {
            let pC = 0, tC = 0, fC = 0;
            html += `<tr><td class="sticky-col name-cell">${est.nombre_completo}</td>`;

            fechas.forEach(f => {
                const fStr = f.toISOString().split('T')[0];
                const esFer = fechasFeriados.includes(fStr);
                const reg = asistencias.find(a => a.user_auth_id === est.auth_id && a.fecha === fStr);
                
                let letra = '-', cl = 'cell-empty';
                if (esFer) { letra = 'H'; cl = 'cell-feriado'; }
                else if (reg) {
                    if (reg.estado === 'PRESENTE') { letra = 'P'; cl = 'cell-presente'; pC++; globalP++; }
                    else if (reg.estado === 'TARDANZA') { letra = 'T'; cl = 'cell-tardanza'; tC++; globalT++; }
                    else if (reg.estado === 'FALTA') { letra = 'F'; cl = 'cell-falta'; fC++; globalF++; }
                }
                html += `<td class="matrix-cell ${cl}">${letra}</td>`;
            });

            html += `<td class="summary-cell col-p">${pC}</td>
                    <td class="summary-cell col-t">${tC}</td>
                    <td class="summary-cell col-f">${fC}</td></tr>`;
        });

        // Fila Totales
        html += `<tr class="total-row"><td class="sticky-col name-cell">TOTAL GENERAL</td>`;
        fechas.forEach(f => {
            const fStr = f.toISOString().split('T')[0];
            const esFer = fechasFeriados.includes(fStr);
            const total = esFer ? '-' : asistencias.filter(a => a.fecha === fStr && (a.estado === 'PRESENTE' || a.estado === 'TARDANZA')).length;
            html += `<td class="matrix-cell">${total}</td>`;
        });
        html += `<td class="summary-total tot-p">${globalP}</td>
                <td class="summary-total tot-t">${globalT}</td>
                <td class="summary-total tot-f">${globalF}</td></tr></tbody></table></div>`;
        
        container.innerHTML = html;
    }




//FERIADOS================================================
// 1. Cargar la lista de feriados desde Supabase
async function cargarFeriados() {
    const tbody = document.getElementById('lista-feriados-body');
    tbody.innerHTML = '<tr><td colspan="3" class="text-center">Cargando feriados...</td></tr>';

    try {
        const { data, error } = await supabaseClient
            .from('feriados')
            .select('*')
            .order('fecha', { ascending: true });

        if (error) throw error;

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-center">No hay feriados registrados.</td></tr>';
            return;
        }

        tbody.innerHTML = data.map(f => `
            <tr>
                <td style="font-weight: bold;">${f.fecha.split('-').reverse().join('/')}</td>
                <td>${f.descripcion}</td>
                <td>
                    <button class="btn-icon" onclick="eliminarFeriado(${f.id_feriado})" style="color: #ef4444;" title="Eliminar Feriado">
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                </td>
            </tr>
        `).join('');

    } catch (err) {
        console.error("Error al cargar feriados:", err);
        tbody.innerHTML = '<tr><td colspan="3" style="color:red;">Error al cargar datos.</td></tr>';
    }
}

// 2. Guardar un nuevo feriado
async function guardarFeriado() {
    const fecha = document.getElementById('fer-fecha').value;
    const desc = document.getElementById('fer-desc').value;

    if (!fecha || !desc) return alert("Complete todos los campos.");

    try {
        const { error } = await supabaseClient
            .from('feriados')
            .insert([{ fecha: fecha, descripcion: desc }]);

        if (error) {
            if (error.code === '23505') throw new Error("Esta fecha ya está registrada como feriado.");
            throw error;
        }

        // Limpiar campos y recargar
        document.getElementById('fer-fecha').value = '';
        document.getElementById('fer-desc').value = '';
        alert("Feriado registrado correctamente.");
        cargarFeriados();

    } catch (err) {
        alert(err.message);
    }
}

// 3. Eliminar un feriado
async function eliminarFeriado(id) {
    if (!confirm("¿Está seguro de eliminar este feriado? El cambio afectará los reportes de asistencia inmediatamente.")) return;

    try {
        const { error } = await supabaseClient
            .from('feriados')
            .delete()
            .eq('id_feriado', id);

        if (error) throw error;

        cargarFeriados();
    } catch (err) {
        alert("Error al eliminar: " + err.message);
    }
}





    //============= Botón de hamburguesa Universal
    document.addEventListener('DOMContentLoaded', () => {
        const menuToggle = document.getElementById('menu-toggle');
        const sidebar = document.getElementById('sidebar');
        const content = document.querySelector('.main-content') || document.querySelector('.content');

        if (menuToggle && sidebar) {
            menuToggle.addEventListener('click', (e) => {
                e.stopPropagation(); // Evita que el clic se pierda
                
                if (window.innerWidth <= 768) {
                    // MÓVIL: Añadimos o quitamos la clase 'open'
                    sidebar.classList.toggle('open');
                    console.log("Menú móvil toggle"); // Para que veas en consola si funciona
                } else {
                    // ESCRITORIO
                    sidebar.classList.toggle('collapsed');
                    if (content) content.classList.toggle('expanded');
                }
            });
        }

        // CERRAR SI HACES CLIC FUERA (Muy importante en móvil)
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 && 
                sidebar.classList.contains('open') && 
                !sidebar.contains(e.target) && 
                e.target !== menuToggle) {
                sidebar.classList.remove('open');
            }
        });
    });

    

    function showSection(sectionId) {
        const esAdministradorGlobal = window.miRolUsuario === 'ADMINISTRADOR' || window.miRolUsuario === 'ADMIN';

        // =================================================================
        // INTERCEPTOR DE SEGURIDAD CON BYPASS PARA ADMINISTRADORES
        // =================================================================
        const seccionesProtegidas = ['marcar-asistencia', 'configuracion', 'evaluacion'];

        if (seccionesProtegidas.includes(sectionId)) {
            if (!esAdministradorGlobal) {
                if (!window.misPermisosUsuario || !window.misPermisosUsuario.includes(sectionId)) {
                    alert("Acceso Restringido: Su rol de usuario no cuenta con autorización para ingresar a este módulo.");
                    return; // Bloqueo
                }
            }
        }

        // =================================================================
        // BLINDAJE ESPECÍFICO PARA EL ACCESO A "VER SECCIÓN"
        // =================================================================
        if (sectionId === 'ver-seccion' && !esAdministradorGlobal) {
            const tieneTutoriaAsignada = window.misSeccionesTutoria && window.misSeccionesTutoria.length > 0;
            if (!tieneTutoriaAsignada) {
                alert("Acceso Restringido: Este módulo está disponible únicamente para Docentes con carga de Tutoría.");
                return; // Bloqueo absoluto
            }
        }

        // =================================================================
        // NUEVO: ACTUALIZACIÓN DINÁMICA DEL TÍTULO DE LA TOP-BAR
        // =================================================================
        const titulosModulos = {
            'dashboard': 'Dashboard',
            'marcar-asistencia': 'Marcar Asistencia',
            'evaluacion': 'Evaluación',
            'mi-asistencia': 'Mi Asistencia',
            'ver-seccion': 'Ver Sección',
            'mi-progreso': 'Mi Progreso',
            'configuracion': 'Configuración'
        };

        const elTituloTopBar = document.getElementById('section-title');
        if (elTituloTopBar && titulosModulos[sectionId]) {
            elTituloTopBar.innerText = titulosModulos[sectionId];
        }
        // =================================================================

        // 1. Ocultar todas las secciones
        document.querySelectorAll('.app-section').forEach(section => {
            section.style.display = 'none';
        });

        // 2. Mostrar la sección seleccionada
        const targetSection = document.getElementById(sectionId);
        if (targetSection) {
            targetSection.style.display = 'block';
        }

        const sidebar = document.getElementById('sidebar');
        if (window.innerWidth <= 768) {
            sidebar.classList.remove('open');
        }

        // Lógicas específicas de carga por sección
        if (sectionId === 'ver-seccion') { 
            inicializarFechaReporte(); 
        }
        if (sectionId === 'marcar-asistencia') { cargarAsistenciasRecientes(); }
        if (sectionId === 'evaluacion') { inicializarSeccionEvaluacion(); }
        if (sectionId === 'mi-progreso') { inicializarSeccionProgreso(); }

        actualizarEstadoSidebar(sectionId);
    }

    
    
    //============================================================
    
    
    
    // Variables Globales del Módulo de Evaluación
    let evalAsignacionesDocente = [];
    let evalEscalasCalificacion = [];
    let evalAnioActivo = null;
    let evalUsuarioDocente = null;

    // 1. Inicialización de Entorno y Variables Críticas
    async function inicializarSeccionEvaluacion() {
        const nivelSelect = document.getElementById('eval-nivel');
        nivelSelect.innerHTML = '<option value="">Cargando...</option>';
        limpiarTablaEval();

        try {
            // A. Validar la sesión del docente autenticado
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (!session) return;

            // B. Resolver el id_usu del docente conectado
            const { data: userReg, error: errU } = await supabaseClient
                .from('usuarios')
                .select('*')
                .eq('auth_id', session.user.id)
                .single();
            if (errU) throw errU;
            evalUsuarioDocente = userReg;

            // C. Obtener el Año Académico Vigente
            const { data: anioReg, error: errA } = await supabaseClient
                .from('anio_academico')
                .select('*')
                .eq('estado', 'ACTIVO')
                .single();
            if (errA) throw errA;
            evalAnioActivo = anioReg;

            // D. Cargar las Escalas Oficiales de Calificación ordenadas de mayor a menor
            const { data: escalas, error: errE } = await supabaseClient
                .from('escalas_calificacion')
                .select('*')
                .order('valor_decimal', { ascending: false }); // Orden descendente
                
            if (errE) throw errE;
            evalEscalasCalificacion = escalas;

            // =================================================================
            // CORREGIDO — E. Obtener Periodos ordenados cronológicamente
            // =================================================================
            const { data: periodos, error: errP } = await supabaseClient
                .from('periodos_evaluacion')
                .select('*')
                .eq('id_anio', evalAnioActivo.id_anio)
                .order('fecha_inicio', { ascending: true }); // <--- De más antiguo a más reciente
                
            if (errP) throw errP;

            const pSelect = document.getElementById('eval-periodo');
            pSelect.innerHTML = periodos.map(p => 
                `<option value="${p.id_periodo}" ${p.activo ? 'selected' : ''}>${p.nombre_periodo}</option>`
            ).join('');
            // =================================================================

            // F. Cargar Cursos Asignados al Docente con sus Relaciones
            const { data: asignaciones, error: errAsig } = await supabaseClient
                .from('cursos_asignados')
                .select(`
                    id_asignacion, id_curso, id_sec, id_usu, id_anio,
                    cursos (nombre_curso, abreviatura),
                    secciones (id_sec, nivel, grado, nombre_sec, id_anio)
                `)
                .eq('id_usu', evalUsuarioDocente.id_usu)
                .eq('id_anio', evalAnioActivo.id_anio);
            if (errAsig) throw errAsig;

            evalAsignacionesDocente = asignaciones;

            // G. Extraer y poblar Niveles asignados únicos
            const nivelesUnicos = [...new Set(asignaciones.map(a => a.secciones?.nivel).filter(Boolean))];
            if (nivelesUnicos.length === 0) {
                nivelSelect.innerHTML = '<option value="">Sin cursos asignados</option>';
                return;
            }

            nivelSelect.innerHTML = '<option value="">Seleccione Nivel...</option>' + 
                nivelesUnicos.map(n => `<option value="${n}">${n}</option>`).join('');

            // Restablecer estados de control
            document.getElementById('eval-grado').disabled = true;
            document.getElementById('eval-seccion').disabled = true;
            document.getElementById('eval-curso').disabled = true;
            document.getElementById('eval-competencia').disabled = true;

        } catch (err) {
            console.error("Error en inicializarSeccionEvaluacion:", err);
            nivelSelect.innerHTML = '<option value="">Error de conexión</option>';
        }
    }

    // 2. Controladores de Filtros en Cascada Estrictos
    function filtrarGradosEval() {
        const nivel = document.getElementById('eval-nivel').value;
        const gradoSelect = document.getElementById('eval-grado');
        
        gradoSelect.innerHTML = '<option value="">Seleccione Grado...</option>';
        document.getElementById('eval-seccion').innerHTML = '<option value="">Seleccione Sección...</option>';
        document.getElementById('eval-curso').innerHTML = '<option value="">Seleccione Curso...</option>';
        document.getElementById('eval-competencia').innerHTML = '<option value="">Seleccione Competencia...</option>';
        
        gradoSelect.disabled = !nivel;
        document.getElementById('eval-seccion').disabled = true;
        document.getElementById('eval-curso').disabled = true;
        document.getElementById('eval-competencia').disabled = true;
        limpiarTablaEval();

        if (!nivel) return;

        const grados = evalAsignacionesDocente
            .filter(a => a.secciones?.nivel === nivel)
            .map(a => a.secciones?.grado);
        const gradosUnicos = [...new Set(grados)].sort();

        gradoSelect.innerHTML += gradosUnicos.map(g => `<option value="${g}">${g}</option>`).join('');
    }

    function filtrarSeccionesEval() {
        const nivel = document.getElementById('eval-nivel').value;
        const grado = document.getElementById('eval-grado').value;
        const secSelect = document.getElementById('eval-seccion');

        secSelect.innerHTML = '<option value="">Seleccione Sección...</option>';
        document.getElementById('eval-curso').innerHTML = '<option value="">Seleccione Curso...</option>';
        document.getElementById('eval-competencia').innerHTML = '<option value="">Seleccione Competencia...</option>';

        secSelect.disabled = !grado;
        document.getElementById('eval-curso').disabled = true;
        document.getElementById('eval-competencia').disabled = true;
        limpiarTablaEval();

        if (!grado) return;

        const filtradas = evalAsignacionesDocente.filter(a => 
            a.secciones?.nivel === nivel && a.secciones?.grado === grado
        );
        
        const mapasSec = new Map();
        filtradas.forEach(a => { if (a.secciones) mapasSec.set(a.secciones.id_sec, a.secciones.nombre_sec); });

        mapasSec.forEach((nombre, id) => {
            secSelect.innerHTML += `<option value="${id}">${nombre}</option>`;
        });
    }

    function cargarCursosEval() {
        const idSec = document.getElementById('eval-seccion').value;
        const cursoSelect = document.getElementById('eval-curso');

        cursoSelect.innerHTML = '<option value="">Seleccione Curso...</option>';
        document.getElementById('eval-competencia').innerHTML = '<option value="">Seleccione Competencia...</option>';

        cursoSelect.disabled = !idSec;
        document.getElementById('eval-competencia').disabled = true;
        limpiarTablaEval();

        if (!idSec) return;

        const filtrados = evalAsignacionesDocente.filter(a => a.id_sec == idSec);
        filtrados.forEach(a => {
            if (a.cursos) {
                cursoSelect.innerHTML += `<option value="${a.id_asignacion}" data-curso="${a.id_curso}">${a.cursos.nombre_curso}</option>`;
            }
        });
    }

    async function cargarCompetenciasEval() {
        const cursoSelect = document.getElementById('eval-curso');
        const idAsignacion = cursoSelect.value;
        const compSelect = document.getElementById('eval-competencia');

        compSelect.innerHTML = '<option value="">Seleccione Competencia...</option>';
        compSelect.disabled = !idAsignacion;
        limpiarTablaEval();

        if (!idAsignacion) return;

        const opcion = cursoSelect.options[cursoSelect.selectedIndex];
        const idCurso = opcion.getAttribute('data-curso');

        compSelect.innerHTML = '<option value="">Cargando competencias...</option>';

        try {
            const { data: competencias, error } = await supabaseClient
                .from('competencias')
                .select('*')
                .eq('id_curso', idCurso);

            if (error) throw error;

            compSelect.innerHTML = '<option value="">Seleccione Competencia...</option>' +
                competencias.map(c => `<option value="${c.id_competencia}">${c.descripcion_competencia}</option>`).join('');

        } catch (err) {
            console.error("Error al cargar competencias:", err);
            compSelect.innerHTML = '<option value="">Error al cargar</option>';
        }
    }

    function limpiarTablaEval() {
        document.getElementById('eval-tabla-contenedor').style.display = 'none';
        document.getElementById('eval-empty-state').style.display = 'block';
        document.getElementById('tbody-eval-notas').innerHTML = '';
    }

    // 3. Extracción de Alumnos Activos y Mapeo de Notas Existentes
    async function cargarRegistroNotas() {
        const idSec = document.getElementById('eval-seccion').value;
        const idAsignacion = document.getElementById('eval-curso').value;
        const idCompetencia = document.getElementById('eval-competencia').value;
        const idPeriodo = document.getElementById('eval-periodo').value;

        if (!idSec || !idAsignacion || !idCompetencia || !idPeriodo) {
            return alert("Establezca todos los filtros obligatorios.");
        }

        const tbody = document.getElementById('tbody-eval-notas');
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:25px;">Sincronizando estudiantes y calificaciones...</td></tr>';
        document.getElementById('eval-empty-state').style.display = 'none';
        document.getElementById('eval-tabla-contenedor').style.display = 'block';

        try {
            // A. Traer Alumnos Matriculados con Estado Activo
            const { data: matriculados, error: errMat } = await supabaseClient
                .from('matriculas')
                .select('id_est, estudiantes(id_est, apellido_paterno, apellido_materno, nombres)')
                .eq('id_sec', idSec)
                .eq('estado', 'ACTIVO');

            if (errMat) throw errMat;

            if (!matriculados || matriculados.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: #64748b; padding:25px;">No existen estudiantes con matrícula ACTIVA en el aula seleccionada.</td></tr>';
                return;
            }

            // Ordenar alfabéticamente en mayúsculas
            let listaAlumnos = matriculados.map(m => ({
                id_est: m.estudiantes.id_est,
                nombre_completo: `${m.estudiantes.apellido_paterno} ${m.estudiantes.apellido_materno}, ${m.estudiantes.nombres}`.toUpperCase()
            })).sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo));

            // =================================================================
            // CORREGIDO: Consultar la columna 'activo' en lugar de 'estado'
            // =================================================================
            const [resNotas, resPeriodo] = await Promise.all([
                supabaseClient.from('calificaciones').select('*').eq('id_asignacion', idAsignacion).eq('id_competencia', idCompetencia).eq('id_periodo', idPeriodo),
                supabaseClient.from('periodos_evaluacion').select('activo').eq('id_periodo', idPeriodo).maybeSingle()
            ]);

            if (resNotas.error) throw resNotas.error;
            
            const notasExistentes = resNotas.data || [];
            
            // Si resPeriodo tiene datos y 'activo' es false, el periodo está CERRADO
            const esPeriodoCerrado = resPeriodo.data ? (resPeriodo.data.activo === false) : false;
            // =================================================================

            // C. Construir Filas Dinámicas con Resaltado de Color
            tbody.innerHTML = listaAlumnos.map((alumno, index) => {
                const notaReg = notasExistentes.find(n => n.id_est === alumno.id_est);
                const idNotaActual = notaReg ? notaReg.id_nota : '';
                const idEscalaActual = notaReg ? notaReg.id_escala : '';
                const fechaReg = notaReg ? new Date(notaReg.fecha_registro).toLocaleDateString('es-PE') : '-';

                let claseColorInicial = '';
                if (idEscalaActual === 'AD') claseColorInicial = 'nota-ad';
                else if (idEscalaActual === 'A') claseColorInicial = 'nota-a';
                else if (idEscalaActual === 'B') claseColorInicial = 'nota-b';
                else if (idEscalaActual === 'C') claseColorInicial = 'nota-c';

                const opcionesEscala = evalEscalasCalificacion.map(e => 
                    `<option value="${e.id_escala}" ${e.id_escala == idEscalaActual ? 'selected' : ''}>${e.id_escala}</option>`
                ).join('');

                const selectDisabled = esPeriodoCerrado ? 'disabled' : '';
                const estiloBloqueado = esPeriodoCerrado ? 'opacity: 0.85; cursor: not-allowed;' : 'cursor: pointer;';

                return `
                    <tr data-id-est="${alumno.id_est}" data-id-nota="${idNotaActual}" style="border-bottom: 1px solid #f1f5f9;">
                        <td style="text-align: center; padding: 8px; font-weight: bold; color: #94a3b8;">${index + 1}</td>
                        <td style="text-align: left; padding: 8px; font-weight: 600; color: #334155;">${alumno.nombre_completo}</td>
                        <td style="text-align: center; padding: 8px;">
                            <select class="input-style eval-select-nota ${claseColorInicial}" 
                                    onchange="cambiarColorNotaEnVivo(this)"
                                    ${selectDisabled}
                                    style="width: 100%; max-width: 120px; height: 34px; text-align: center; font-weight: bold; margin: 0 auto; padding: 2px; transition: all 0.2s; ${estiloBloqueado}">
                                <option value="">--</option>
                                ${opcionesEscala}
                            </select>
                        </td>
                        <td style="text-align: left; padding: 8px; color: #64748b; font-size: 0.8rem;">${fechaReg}</td>
                    </tr>
                `;
            }).join('');

            // Control visual sobre el botón de Guardar Calificaciones
            const btnGuardar = document.querySelector('button[onclick="guardarCalificacionesMasa()"]');
            if (btnGuardar) {
                if (esPeriodoCerrado) {
                    btnGuardar.disabled = true;
                    btnGuardar.style.backgroundColor = '#94a3b8';
                    btnGuardar.style.borderColor = '#94a3b8';
                    btnGuardar.style.cursor = 'not-allowed';
                    btnGuardar.innerHTML = '<span class="material-symbols-outlined">lock</span> Registro Bloqueado (Periodo Cerrado)';
                } else {
                    btnGuardar.disabled = false;
                    btnGuardar.style.backgroundColor = '#22c55e';
                    btnGuardar.style.borderColor = '#22c55e';
                    btnGuardar.style.cursor = 'pointer';
                    btnGuardar.innerHTML = '<span class="material-symbols-outlined">save</span> Guardar Calificativos';
                }
            }

        } catch (err) {
            console.error("Error en cargarRegistroNotas:", err);
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:red; padding:25px;">Error al estructurar el registro auxiliar.</td></tr>';
        }
    }

    // 4. Procesamiento Transaccional Masivo (Upsert)
    async function guardarCalificacionesMasa() {
        const idAsignacion = document.getElementById('eval-curso').value;
        const idCompetencia = document.getElementById('eval-competencia').value;
        const idPeriodo = document.getElementById('eval-periodo').value;

        if (!idAsignacion || !idCompetencia || !idPeriodo) return;

        // =================================================================
        // CORREGIDO: Validar utilizando el campo booleano 'activo'
        // =================================================================
        try {
            const { data: periodoCheck, error: errCheck } = await supabaseClient
                .from('periodos_evaluacion')
                .select('activo')
                .eq('id_periodo', idPeriodo)
                .maybeSingle();

            if (errCheck) throw errCheck;

            // Si existe el periodo y activo es false, significa que está cerrado
            if (periodoCheck && periodoCheck.activo === false) {
                return alert("Acceso denegado: El periodo académico seleccionado se encuentra CERRADO. No se permiten modificaciones ni registros nuevos en las calificaciones.");
            }
        } catch (segErr) {
            console.error("Error de control de cierre:", segErr);
            return alert("No se pudo verificar el estado de cierre del periodo. Inténtelo más tarde.");
        }
        // =================================================================

        const filas = document.querySelectorAll('#tbody-eval-notas tr');
        
        const registrosNuevos = [];
        const registrosActualizar = [];

        filas.forEach(fila => {
            const idEst = fila.getAttribute('data-id-est');
            const idNota = fila.getAttribute('data-id-nota') || null;
            const idEscala = fila.querySelector('.eval-select-nota').value;

            if (idEscala) {
                const registro = {
                    id_est: parseInt(idEst),
                    id_asignacion: parseInt(idAsignacion),
                    id_competencia: parseInt(idCompetencia),
                    id_periodo: parseInt(idPeriodo),
                    id_escala: idEscala, 
                    id_usu_registro: evalUsuarioDocente.id_usu,
                    fecha_registro: new Date().toISOString()
                };

                if (idNota) {
                    registro.id_nota = parseInt(idNota);
                    registrosActualizar.push(registro);
                } else {
                    registrosNuevos.push(registro); 
                }
            }
        });

        if (registrosNuevos.length === 0 && registrosActualizar.length === 0) {
            return alert("Establezca al menos un calificativo válido antes de guardar.");
        }

        try {
            // Ejecución 1: Guardar notas totalmente nuevas
            if (registrosNuevos.length > 0) {
                const { error: insertError } = await supabaseClient
                    .from('calificaciones')
                    .insert(registrosNuevos);

                if (insertError) throw insertError;
            }

            // Ejecución 2: Modificar de forma segura las notas existentes
            if (registrosActualizar.length > 0) {
                const { error: updateError } = await supabaseClient
                    .from('calificaciones')
                    .upsert(registrosActualizar, { onConflict: 'id_nota' });

                if (updateError) throw updateError;
            }

            alert("¡Calificativos guardados de manera exitosa!");
            cargarRegistroNotas();

        } catch (err) {
            console.error("Error masivo en guardarCalificacionesMasa:", err);
            alert("Fallo transaccional al guardar las notas: " + err.message);
        }
    }

    // Función para cambiar el color del selector de nota en tiempo real
    function cambiarColorNotaEnVivo(selectElement) {
        // 1. Remover cualquier clase de nota previa
        selectElement.classList.remove('nota-ad', 'nota-a', 'nota-b', 'nota-c');
        
        // 2. Obtener el nuevo calificativo seleccionado
        const notaSeleccionada = selectElement.value;
        
        // 3. Aplicar la nueva clase correspondiente
        if (notaSeleccionada === 'AD') selectElement.classList.add('nota-ad');
        else if (notaSeleccionada === 'A') selectElement.classList.add('nota-a');
        else if (notaSeleccionada === 'B') selectElement.classList.add('nota-b');
        else if (notaSeleccionada === 'C') selectElement.classList.add('nota-c');
    }


    //=====================================================
    // Función para generar e imprimir el Registro de Calificaciones en formato VERTICAL (Portrait)
    // Función para generar e imprimir el Registro de Calificaciones en formato VERTICAL (Compacto)
    async function imprimirRegistroNotasPDF() {
        const cursoSelect = document.getElementById('eval-curso');
        const idAsignacion = cursoSelect.value;
        const idSec = document.getElementById('eval-seccion').value;
        const idPeriodo = document.getElementById('eval-periodo').value;

        if (!idSec || !idAsignacion || !idPeriodo) {
            return alert("Por favor, cargue primero los estudiantes para poder exportar.");
        }

        // Obtener metadatos de los selectores para los encabezados
        const idCurso = cursoSelect.options[cursoSelect.selectedIndex].getAttribute('data-curso');
        const nombreCurso = cursoSelect.options[cursoSelect.selectedIndex].text.toUpperCase();
        const nombrePeriodo = document.getElementById('eval-periodo').options[document.getElementById('eval-periodo').selectedIndex].text.toUpperCase();
        
        const filtros = {
            nivel: document.getElementById('eval-nivel').value.toUpperCase(),
            grado: document.getElementById('eval-grado').value.toUpperCase(),
            seccion: document.getElementById('eval-seccion').options[document.getElementById('eval-seccion').selectedIndex].text.toUpperCase()
        };

        try {
            // 1. Consultar en paralelo las competencias, alumnos activos y notas
            const [resComp, resMat, resNotas] = await Promise.all([
                supabaseClient.from('competencias').select('*').eq('id_curso', idCurso).order('id_competencia', { ascending: true }),
                supabaseClient.from('matriculas').select('id_est, estudiantes(id_est, apellido_paterno, apellido_materno, nombres)').eq('id_sec', idSec).eq('estado', 'ACTIVO'),
                supabaseClient.from('calificaciones').select('*').eq('id_asignacion', idAsignacion).eq('id_periodo', idPeriodo)
            ]);

            if (resComp.error) throw resComp.error;
            if (resMat.error) throw resMat.error;
            if (resNotas.error) throw resNotas.error;

            const listaCompetencias = resComp.data || [];
            if (listaCompetencias.length === 0) {
                return alert("Este curso no tiene competencias asociadas registradas en la base de datos.");
            }

            // 2. Formatear y ordenar estudiantes alfabéticamente
            let listaAlumnos = resMat.data.map(m => ({
                id_est: m.estudiantes.id_est,
                nombre_completo: `${m.estudiantes.apellido_paterno} ${m.estudiantes.apellido_materno}, ${m.estudiantes.nombres}`.toUpperCase()
            })).sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo));

            const todasNotas = resNotas.data || [];

            // 3. Estructura HTML optimizada para formato vertical compacto
            let htmlPrint = `
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    @page { 
                        size: A4 portrait; 
                        margin: 1.5cm; 
                    }
                    body { font-family: sans-serif; color: #333; margin: 0; }
                    
                    /* Títulos y Encabezados */
                    .header-container { text-align: center; margin-bottom: 12px; }
                    .header-container h2 { margin: 0; font-size: 11pt; color: #0056b3; text-transform: uppercase; letter-spacing: 0.5px; }
                    .header-container h3 { margin: 4px 0 0 0; font-size: 9pt; color: #475569; }
                    
                    .info-bar { 
                        display: flex; justify-content: space-between; 
                        background: #f0f7ff; border-bottom: 2px solid #007bff;
                        padding: 4px 10px; margin-bottom: 12px; font-weight: bold; font-size: 8pt; color: #1e3a8a;
                    }

                    /* --- AJUSTE GLOBAL DE TABLA Y FILAS --- */
                    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
                    
                    /* Estilos base de celdas */
                    th, td { 
                        border: 1px solid #b3d7ff; 
                        text-align: center; 
                        line-height: 1.0; /* Reducción de interlineado */
                        box-sizing: border-box;
                    }
                    
                    /* Encabezado: Un poco más visible */
                    thead th { 
                        padding: 5px 2px; 
                        font-size: 8pt; 
                        background: #007bff; 
                        color: white;
                    }
                    
                    /* Filas del Cuerpo: Reducción de fuente y altura */
                    tbody td { 
                        padding: 4px 4px; /* Relleno vertical mínimo */
                        font-size: 9pt;      /* Fuente más pequeña para los datos */
                    }
                    
                    /* Configuración de anchos de columnas */
                    .col-num { width: 25px; }
                    
                    .col-nombre { 
                        width: 350px; /* Ancho optimizado para nombres en Portrait */
                        text-align: left; 
                        padding-left: 5px;
                        white-space: nowrap; 
                        overflow: hidden; 
                        text-overflow: ellipsis;
                        font-weight: 600;
                    }
                    
                    .col-comp { 
                        width: 50px; /* Columnas de calificaciones delgadas */
                    }
                    
                    /* Estilos Semánticos Oficiales para Calificativos */
                    .AD { background-color: #e0f2fe !important; color: #0369a1 !important; -webkit-print-color-adjust: exact; font-weight: bold; }
                    .A  { background-color: #dcfce7 !important; color: #15803d !important; -webkit-print-color-adjust: exact; font-weight: bold; }
                    .B  { background-color: #ffedd5 !important; color: #b45309 !important; -webkit-print-color-adjust: exact; font-weight: bold; }
                    .C  { background-color: #fee2e2 !important; color: #b91c1c !important; -webkit-print-color-adjust: exact; font-weight: bold; }
                    
                    tr:nth-child(even) { background: #fdfdfd; }
                    
                    /* Leyenda de Competencias inferior */
                    .legend-container { margin-top: 20px; background: #f8fafc; border: 1px solid #e2e8f0; padding: 8px; border-radius: 6px; }
                    .legend-title { font-weight: bold; color: #334155; margin-bottom: 4px; font-size: 8pt; text-transform: uppercase; }
                    .legend-item { margin-bottom: 3px; color: #475569; line-height: 1.2; text-align: left; font-size: 7.5pt; }
                </style>
            </head>
            <body>
                <div class="header-container">
                    <h2>REGISTRO AUXILIAR DE EVALUACIÓN</h2>
                    <h3>ÁREA / CURSO: ${nombreCurso} — ${nombrePeriodo}</h3>
                </div>
                
                <div class="info-bar">
                    <span>NIVEL: ${filtros.nivel}</span>
                    <span>GRADO: ${filtros.grado}</span>
                    <span>SECCIÓN: ${filtros.seccion}</span>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th class="col-num">N°</th>
                            <th class="col-nombre">APELLIDOS Y NOMBRES</th>
                            ${listaCompetencias.map((c, i) => `<th class="col-comp">C${i + 1}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${listaAlumnos.map((alumno, index) => {
                            const celdasNotas = listaCompetencias.map(comp => {
                                const nota = todasNotas.find(n => n.id_est === alumno.id_est && n.id_competencia === comp.id_competencia);
                                const notaTexto = nota ? nota.id_escala : '-';
                                return `<td class="${notaTexto}">${notaTexto}</td>`;
                            }).join('');

                            return `
                            <tr>
                                <td style="color: #64748b; font-weight: bold;">${index + 1}</td>
                                <td class="col-nombre">${alumno.nombre_completo}</td>
                                ${celdasNotas}
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>

                <div class="legend-container">
                    <div class="legend-title">Glosario de Competencias Evaluadas:</div>
                    ${listaCompetencias.map((c, i) => `
                        <div class="legend-item"><strong>C${i + 1}:</strong> ${c.descripcion_competencia}</div>
                    `).join('')}
                </div>
            </body>
            </html>`;

            // 4. Abrir ventana de impresión
            const v = window.open('', '_blank');
            v.document.write(htmlPrint);
            v.document.close();
            v.onload = () => v.print();

        } catch (err) {
            console.error("Error al generar PDF de notas:", err);
            alert("Ocurrió un error al procesar el reporte en PDF: " + err.message);
        }
    }


    //=================================================================
    //Funciones del Motor de Permisos
    let cacheTodosPermisos = []; // Guarda los permisos en memoria para no saturar consultas

    // 1. Cargar el catálogo completo de roles y de permisos del sistema
    async function inicializarModuloPermisos() {
        const selectRol = document.getElementById('perm-select-rol');
        selectRol.innerHTML = '<option value="">Cargando roles...</option>';
        document.getElementById('perm-panel-matriz').style.display = 'none';
        document.getElementById('perm-empty-state').style.display = 'block';

        try {
            // Consultar de forma paralela todas las opciones disponibles
            const [resRoles, resPermisos] = await Promise.all([
                supabaseClient.from('roles').select('*').order('nombre_rol', { ascending: true }),
                supabaseClient.from('permisos').select('*').order('modulo', { ascending: true })
            ]);

            if (resRoles.error) throw resRoles.error;
            if (resPermisos.error) throw resPermisos.error;

            cacheTodosPermisos = resPermisos.data || [];

            // Poblar el selector desplegable de Roles
            selectRol.innerHTML = '<option value="">Seleccione un rol...</option>' +
                resRoles.data.map(r => `<option value="${r.id_rol}">${r.nombre_rol.toUpperCase()}</option>`).join('');

            // Dibujar y agrupar visualmente la matriz por su módulo
            dibujarMatrizPermisosHTML();

        } catch (err) {
            console.error("Error al inicializar permisos:", err);
            selectRol.innerHTML = '<option value="">Error al conectar</option>';
        }
    }

    // 2. Agrupar los permisos por módulos y renderizar las tarjetas con checkboxes
    function dibujarMatrizPermisosHTML() {
        const contenedor = document.getElementById('perm-grid-modulos');
        
        // Organizar permisos en un objeto agrupado por el campo 'modulo'
        const modulosAgrupados = {};
        cacheTodosPermisos.forEach(p => {
            if (!modulosAgrupados[p.modulo]) modulosAgrupados[p.modulo] = [];
            modulosAgrupados[p.modulo].push(p);
        });

        // Inyectar el HTML estructurado
        contenedor.innerHTML = Object.keys(modulosAgrupados).map(modulo => {
            const checkboxesHtml = modulosAgrupados[modulo].map(p => `
                <label class="perm-item-checkbox">
                    <input type="checkbox" class="chk-permiso" value="${p.id_permiso}" id="chk-p-${p.id_permiso}">
                    <div class="perm-info-text">
                        <strong>${p.accion.toUpperCase()}</strong>
                        <span>${p.descripcion || 'Sin descripción asignada.'}</span>
                        <span style="font-size:0.65rem; color:#3b82f6; font-family:monospace; margin-top:2px;">slug: ${p.slug}</span>
                    </div>
                </label>
            `).join('');

            return `
                <div class="perm-modulo-card">
                    <div class="perm-modulo-header">
                        <span class="material-symbols-outlined" style="font-size:18px;">folder_open</span>
                        <span>Módulo: ${modulo}</span>
                    </div>
                    <div class="perm-modulo-body">
                        ${checkboxesHtml}
                    </div>
                </div>
            `;
        }).join('');
    }

    // 3. Sincronizar y marcar los checkboxes que el rol seleccionado ya tiene guardados
    async function cargarPermisosDelRol(idRol) {
        const panelMatriz = document.getElementById('perm-panel-matriz');
        const emptyState = document.getElementById('perm-empty-state');

        // Desmarcar todos los checkboxes por seguridad antes de mapear
        document.querySelectorAll('.chk-permiso').forEach(chk => chk.checked = false);

        if (!idRol) {
            panelMatriz.style.display = 'none';
            emptyState.style.display = 'block';
            return;
        }

        panelMatriz.style.display = 'block';
        emptyState.style.display = 'none';

        try {
            // Traer de Supabase las relaciones existentes para este ID de rol
            const { data: asignados, error } = await supabaseClient
                .from('rol_permisos')
                .select('id_permiso')
                .eq('id_rol', idRol);

            if (error) throw error;

            // Encender los interruptores correspondientes
            asignados.forEach(rp => {
                const chk = document.getElementById(`chk-p-${rp.id_permiso}`);
                if (chk) chk.checked = true;
            });

        } catch (err) {
            console.error("Error al mapear permisos del rol:", err);
            alert("Error al sincronizar los accesos actuales del rol.");
        }
    }

    // 4. Guardar cambios eliminando los permisos anteriores e insertando los nuevos (Guardado Atómico)
    async function guardarPermisosDelRol() {
        const idRol = document.getElementById('perm-select-rol').value;
        if (!idRol) return;

        // Recopilar cuáles checkboxes tienen un 'check' activo
        const seleccionados = document.querySelectorAll('.chk-permiso:checked');
        const loteNuevosPermisos = Array.from(seleccionados).map(chk => ({
            id_rol: parseInt(idRol),
            id_permiso: parseInt(chk.value)
        }));

        try {
            // Paso 1: Eliminar de la tabla rol_permisos todos los accesos actuales de ese rol
            const { error: deleteError } = await supabaseClient
                .from('rol_permisos')
                .delete()
                .eq('id_rol', idRol);

            if (deleteError) throw deleteError;

            // Paso 2: Si marcó casillas, insertar en masa el nuevo lote relacional
            if (loteNuevosPermisos.length > 0) {
                const { error: insertError } = await supabaseClient
                    .from('rol_permisos')
                    .insert(loteNuevosPermisos);

                if (insertError) throw insertError;
            }

            alert("¡Políticas de seguridad y permisos actualizados correctamente!");
            cargarPermisosDelRol(idRol); // Recargar vista para confirmar cambios

        } catch (err) {
            console.error("Error transaccional al guardar permisos:", err);
            alert("No se pudieron guardar los cambios: " + err.message);
        }
    }



    //========================================================================

    // Función Administrativa para cambiar la contraseña de un usuario
    async function modificarPasswordUsuario(authId, dni, nombreCompleto) {
        // Validación de control inicial
        if (!authId || authId === 'null' || authId === 'undefined') {
            return alert("Error: Este usuario no posee un identificador de autenticación activo (auth_id inválido).");
        }

        // Desplegar cuadro interactivo corporativo para ingresar el nuevo password
        const nuevaPassword = prompt(`Modificar contraseña para:\n${nombreCompleto} (DNI: ${dni})\n\nIngrese la nueva contraseña (mínimo 6 caracteres):`);
        
        // Si el usuario canceló el prompt o lo dejó vacío, interrumpimos
        if (nuevaPassword === null) return;
        
        const passwordLimpia = nuevaPassword.trim();
        if (passwordLimpia.length < 6) {
            return alert("La contraseña es demasiado corta. Debe contener al menos 6 caracteres.");
        }

        // Confirmación de seguridad
        if (!confirm(`¿Está seguro de cambiar la contraseña de ${nombreCompleto}? El cambio será inmediato.`)) return;

        try {
            // Invocamos la Edge Function compartiendo el lote relacional
            const { data, error } = await supabaseClient.functions.invoke('registro-masivo', {
                body: { 
                    action: 'updatePassword', // <--- NUEVA ACCIÓN EN EL BACKEND
                    auth_id: authId,
                    password: passwordLimpia 
                }
            });

            if (error) throw error;

            alert(`¡Contraseña actualizada con éxito para el usuario ${nombreCompleto}!`);

        } catch (err) {
            console.error("Error al restablecer contraseña:", err.message);
            alert("Fallo al actualizar la credencial: " + err.message);
        }
    }


    //==========================================================================
    // =================================================================
    // MOTOR GLOBAL DE NOTIFICACIONES Y ALERTAS INTERACTIVAS
    // =================================================================

    /**
     * Renderiza un Pop-up minimalista en el centro de la pantalla.
     * @param {string} mensaje - El texto informativo.
     * @param {string} tipo - Criterio semántico: 'success', 'error', 'warning', 'info'.
     */
    function mostrarAlertaPersonalizada(mensaje, tipo = 'info') {
        return new Promise((resolve) => {
            // 1. Asignar icono correspondiente de Material Symbols
            let icono = 'info';
            if (tipo === 'success') icono = 'check_circle';
            if (tipo === 'error') icono = 'cancel';
            if (tipo === 'warning') icono = 'warning';

            // 2. Construcción e inyección dinámica en el DOM
            const overlay = document.createElement('div');
            overlay.className = `custom-alert-overlay alert-${tipo}`;
            
            overlay.innerHTML = `
                <div class="custom-alert-box">
                    <span class="material-symbols-outlined custom-alert-icon">${icono}</span>
                    <p class="custom-alert-msg">${mensaje}</p>
                    <button class="custom-alert-btn">Aceptar</button>
                </div>
            `;

            document.body.appendChild(overlay);

            // 3. Activar animación de entrada (Zoom + Fade In)
            setTimeout(() => {
                overlay.classList.add('alert-visible');
            }, 10);

            // Auto-enfocar el botón para permitir el cierre rápido presionando la tecla 'Enter'
            const btnAceptar = overlay.querySelector('.custom-alert-btn');
            if (btnAceptar) btnAceptar.focus();

            // 4. Mecanismo de cierre y destrucción del nodo
            const cerrarAlerta = () => {
                overlay.classList.remove('alert-visible');
                setTimeout(() => {
                    overlay.remove();
                    resolve(); // Resuelve la promesa al terminar la animación de salida
                }, 200);
            };

            // Escuchar clics de confirmación
            btnAceptar.addEventListener('click', cerrarAlerta);
            
            // Cerrar opcionalmente si el usuario hace clic en el fondo difuminado externo
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) cerrarAlerta();
            });
        });
    }

    // =================================================================
    // INTEGRADOR AUTOMÁTICO: REEMPLAZO DE WINDOW.ALERT NATIVO
    // =================================================================
    window.alert = function (mensaje) {
        if (!mensaje) return;
        
        const texto = mensaje.toLowerCase();
        let tipoAsignado = 'info';

        // Algoritmo de detección inteligente por palabras clave
        if (texto.includes('éxito') || texto.includes('exitoso') || texto.includes('guardado') || texto.includes('terminada') || texto.includes('bien')) {
            tipoAsignado = 'success';
        } else if (texto.includes('error') || texto.includes('fallo') || texto.includes('denegado') || texto.includes('restringido') || texto.includes('viola')) {
            tipoAsignado = 'error';
        } else if (texto.includes('por favor') || texto.includes('atención') || texto.includes('falta') || texto.includes('seleccione') || texto.includes('corta')) {
            tipoAsignado = 'warning';
        }

        // Ejecutar la ventana flotante estilizada
        mostrarAlertaPersonalizada(mensaje, tipoAsignado);
    };



    //==================================================================
    // Handler interactivo para expandir y colapsar el acordeón de las tarjetas
    function toggleCardAccordion(button) {
        const content = button.nextElementSibling;
        const isVisible = content.style.display === 'block';
        
        // Cerrar otros acordeones abiertos para mantener el minimalismo visual (opcional)
        document.querySelectorAll('.card-accordion-content').forEach(el => el.style.display = 'none');
        document.querySelectorAll('.btn-card-toggle').forEach(el => el.classList.remove('active'));

        if (isVisible) {
            content.style.display = 'none';
            button.classList.remove('active');
        } else {
            content.style.display = 'block';
            button.classList.add('active');
        }
    }

    //==================================================================
    // =================================================================
    // MOTOR CONSOLIDADO: SECCIÓN MI PROGRESO (BÚSQUEDA + SÁBANA DE NOTAS)
    // =================================================================

    // =================================================================
    // ENGINE DE CALIFICACIONES DE PROGRESO Y AGREGACIONES DE FUSIÓN
    // =================================================================

    window.padronEstudiantesProgreso = [];
    window.alumnoSeleccionadoActual = null; // Almacenará la metadata del estudiante en foco

    // Estructura predeterminada de fusiones (Minedu Estándar) guardada en localStorage
    window.rulesFusionesCursos = JSON.parse(localStorage.getItem('newton_cfg_fusiones')) || [
        { id: 1, nombre: "Ciencia y Tecnología", cursosIds: [], promediar: true }
    ];

    /**
     * Controla el intercambio de pestañas visuales
     */
    function cambiarSubTabProgreso(tabName) {
        document.getElementById('btn-progreso-tab-general').classList.remove('active');
        document.getElementById('btn-progreso-tab-fusionado').classList.remove('active');
        document.getElementById('vista-progreso-general').style.display = 'none';
        document.getElementById('vista-progreso-fusionado').style.display = 'none';

        if (tabName === 'general') {
            document.getElementById('btn-progreso-tab-general').classList.add('active');
            document.getElementById('vista-progreso-general').style.display = 'block';
        } else {
            document.getElementById('btn-progreso-tab-fusionado').classList.add('active');
            document.getElementById('vista-progreso-fusionado').style.display = 'block';
            if (window.alumnoSeleccionadoActual) {
                compilarYRenderizarMatrizFusionada();
            }
        }
    }

    /**
     * Inicializa la sección y cachea la lista global de alumnos activos
     */
    async function inicializarSeccionProgreso() {
        const inputBuscar = document.getElementById('progreso-buscar-input');
        inputBuscar.value = '';
        inputBuscar.disabled = true;
        inputBuscar.placeholder = "Sincronizando padrón institucional...";
        
        document.getElementById('progreso-clear-search').style.display = 'none';
        document.getElementById('progreso-resultados-flotantes').style.display = 'none';
        document.getElementById('progreso-tabla-contenedor').style.display = 'none';
        document.getElementById('progreso-empty-state').style.display = 'block';
        window.alumnoSeleccionadoActual = null;

        try {
            if (!window.evalAnioActivo) {
                const { data: anioReg, error: errA } = await supabaseClient.from('anio_academico').select('*').eq('estado', 'ACTIVO').single();
                if (errA) throw errA;
                window.evalAnioActivo = anioReg;
                await cargarFusionesDesdeSupabase();
            }

            const { data: padron, error: errP } = await supabaseClient
                .from('matriculas')
                .select(`
                    id_est, id_sec,
                    secciones!inner(id_sec, grado, nombre_sec, nivel, id_anio),
                    estudiantes!inner(id_est, apellido_paterno, apellido_materno, nombres, dni)
                `)
                .eq('estado', 'ACTIVO')
                .eq('secciones.id_anio', window.evalAnioActivo.id_anio);

            if (errP) throw errP;

            window.padronEstudiantesProgreso = (padron || []).map(item => ({
                id_est: item.id_est,
                id_sec: item.id_sec,
                dni: item.estudiantes?.dni ? item.estudiantes.dni.trim() : '',
                aula_detalle: `${item.secciones.grado} ${item.secciones.nombre_sec} - ${item.secciones.nivel}`,
                nombre_completo: `${item.estudiantes?.apellido_paterno || ''} ${item.estudiantes?.apellido_materno || ''}, ${item.estudiantes?.nombres || ''}`.toUpperCase().trim()
            })).sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo));

            inputBuscar.disabled = false;
            inputBuscar.placeholder = "Escriba DNI, apellidos o nombres...";

        } catch (err) {
            console.error("Error cargando progreso:", err.message);
            inputBuscar.placeholder = "Fallo al conectar con el servidor.";
        }
    }

    function filtrarEstudiantesProgreso() {
        const input = document.getElementById('progreso-buscar-input');
        const valorBusqueda = input.value.trim().toUpperCase();
        const panelResultados = document.getElementById('progreso-resultados-flotantes');
        const btnClear = document.getElementById('progreso-clear-search');

        btnClear.style.display = valorBusqueda.length > 0 ? 'block' : 'none';
        if (valorBusqueda.length < 2) { panelResultados.style.display = 'none'; return; }

        const filtrados = window.padronEstudiantesProgreso.filter(al => 
            al.dni.includes(valorBusqueda) || al.nombre_completo.includes(valorBusqueda)
        );

        if (filtrados.length === 0) {
            panelResultados.innerHTML = `<div style="padding:12px; text-align:center; font-size:0.8rem; color:#94a3b8;">Sin resultados.</div>`;
            panelResultados.style.display = 'block';
            return;
        }

        panelResultados.innerHTML = filtrados.slice(0, 6).map(al => {
            const nomEscapado = al.nombre_completo.replace(/'/g, "\\'");
            const aulaEscapada = al.aula_detalle.replace(/'/g, "\\'");
            return `
                <div class="search-result-item" onclick="seleccionarEstudianteProgreso(${al.id_est}, ${al.id_sec}, '${nomEscapado}', '${aulaEscapada}')">
                    <div class="student-name">${al.nombre_completo}</div>
                    <div class="student-meta"><span>DNI: ${al.dni}</span> <span>Aula: ${al.aula_detalle}</span></div>
                </div>`;
        }).join('');
        panelResultados.style.display = 'block';
    }

    function seleccionarEstudianteProgreso(idEst, idSec, nombreCompleto, aulaDetalle) {
        document.getElementById('progreso-resultados-flotantes').style.display = 'none';
        document.getElementById('progreso-buscar-input').value = nombreCompleto;

        // Resguardar metadatos en caché de foco
        window.alumnoSeleccionadoActual = { id_est: idEst, id_sec: idSec, nombre: nombreCompleto, aula: aulaDetalle };
        
        // Forzar siempre el reinicio a la primera subpestaña por usabilidad
        cambiarSubTabProgreso('general');
        cargarProgresoEstudiante(idEst, nombreCompleto, aulaDetalle);
    }

    /**
     * Carga la matriz de notas detallada (General)
     */
    async function cargarProgresoEstudiante(idEst, nombreCompleto, aulaDetalle) {
        const tbody = document.getElementById('tbody-progreso-notas');
        document.getElementById('progreso-empty-state').style.display = 'none';
        document.getElementById('progreso-tabla-contenedor').style.display = 'block';
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:30px; color:#64748b; font-weight:600;">Estructurando sábanas...</td></tr>';

        document.getElementById('progreso-txt-alumno').innerText = nombreCompleto;
        document.getElementById('progreso-txt-aula').innerText = aulaDetalle;

        try {
            const idSec = window.alumnoSeleccionadoActual.id_sec;

            const [resAsignaciones, resPeriodos, resNotas] = await Promise.all([
                supabaseClient.from('cursos_asignados').select('id_asignacion, id_curso, cursos!fk_cursos(nombre_curso)').eq('id_sec', idSec).eq('id_anio', window.evalAnioActivo.id_anio),
                supabaseClient.from('periodos_evaluacion').select('id_periodo, nombre_periodo').eq('id_anio', window.evalAnioActivo.id_anio).order('fecha_inicio', { ascending: true }),
                supabaseClient.from('calificaciones').select('id_asignacion, id_periodo, id_competencia, id_escala').eq('id_est', idEst)
            ]);

            if (resAsignaciones.error) throw resAsignaciones.error;
            
            // Guardar las colecciones en el contexto de foco para el renderizador cruzado B
            window.alumnoSeleccionadoActual.asignaciones = resAsignaciones.data || [];
            window.alumnoSeleccionadoActual.periodos = resPeriodos.data || [];
            window.alumnoSeleccionadoActual.calificaciones = resNotas.data || [];

            const { data: competencies, error: errC } = await supabaseClient
                .from('competencias')
                .select('id_competencia, id_curso, descripcion_competencia')
                .in('id_curso', window.alumnoSeleccionadoActual.asignaciones.map(a => a.id_curso))
                .order('id_competencia', { ascending: true });

            if (errC) throw errC;
            window.alumnoSeleccionadoActual.competencias = competencies || [];

            // Rediseñar cabeceras dinámicas de la vista General
            const theadRow = document.querySelector('#vista-progreso-general table thead tr');
            theadRow.innerHTML = `<th style="padding:14px 12px; text-align:left; width:240px; font-weight:700;">Curso / Área Curricular</th><th style="padding:14px 12px; text-align:left; min-width:300px; font-weight:700;">Competencias Curriculares</th>`;
            
            window.alumnoSeleccionadoActual.periodos.forEach(p => {
                const th = document.createElement('th');
                th.className = 'th-periodo-dinamico';
                th.innerText = p.nombre_periodo;
                theadRow.appendChild(th);
            });

            // Inyección de filas del reporte detallado
            let matrixHtml = '';
            window.alumnoSeleccionadoActual.asignaciones.sort((a,b)=> (a.cursos?.nombre_curso||'').localeCompare(b.cursos?.nombre_curso||'')).forEach(asig => {
                const nombreCurso = asig.cursos?.nombre_curso || 'Curso';
                const compsDelCurso = window.alumnoSeleccionadoActual.competencias.filter(c => c.id_curso == asig.id_curso);

                if (compsDelCurso.length === 0) {
                    matrixHtml += `<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:12px; font-weight:700;">${nombreCurso}</td><td style="padding:12px; color:#94a3b8; font-style:italic;">Sin competencias definidas</td>${window.alumnoSeleccionadoActual.periodos.map(() => `<td style="text-align:center; color:#cbd5e1;">─</td>`).join('')}</tr>`;
                    return;
                }

                compsDelCurso.forEach((comp, idx) => {
                    matrixHtml += `<tr style="border-bottom:1px solid #f1f5f9; background:#fff;">`;
                    if (idx === 0) matrixHtml += `<td rowspan="${compsDelCurso.length}" style="padding:12px; font-weight:700; color:#0f172a; border-right:1px solid #e2e8f0; vertical-align:middle; background:#fafafa;">${nombreCurso}</td>`;
                    
                    matrixHtml += `<td style="padding:10px 12px; color:#475569; font-weight:500; border-right:1px solid #f1f5f9;"><strong style="color:#0284c7;">C${idx+1}:</strong> ${comp.descripcion_competencia}</td>`;

                    window.alumnoSeleccionadoActual.periodos.forEach(p => {
                        const nota = window.alumnoSeleccionadoActual.calificaciones.find(n => n.id_asignacion == asig.id_asignacion && n.id_periodo == p.id_periodo && n.id_competencia == comp.id_competencia);
                        matrixHtml += `<td style="padding:6px; text-align:center; border-right:1px solid #f1f5f9;">${nota ? `<span class="badge-nota-view nota-${nota.id_escala.toLowerCase()}">${nota.id_escala}</span>` : '<span class="sin-nota">─</span>'}</td>`;
                    });
                    matrixHtml += `</tr>`;
                });
            });
            tbody.innerHTML = matrixHtml;

        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="10" style="color:red; text-align:center; padding:20px;">Fallo analítico: ${err.message}</td></tr>`;
        }
    }

    // =================================================================
    // SISTEMA MATEMÁTICO DE CONSOLIDACIÓN Y PROMEDIOS (VISTA B)
    // =================================================================

    /**
     * Traduce un valor promedio decimal al literal oficial del MINEDU
     * según las reglas exactas proporcionadas por la institución
     */
    function calcularEscalaPorPromedioDecimal(valor) {
        if (valor === null || isNaN(valor)) return '─';
        if (valor >= 3.6) return 'AD';
        if (valor >= 2.7) return 'A';
        if (valor >= 1.5) return 'B';
        return 'C';
    }

    /**
     * Compila, unifica y calcula las sábanas de notas agrupadas
     */
    function compilarYRenderizarMatrizFusionada() {
        const tbody = document.getElementById('tbody-progreso-fusionado');
        const theadRow = document.getElementById('thead-fusionado-row');
        
        // 1. Re-armar cabeceras de bimestres para la vista combinada
        theadRow.innerHTML = `<th style="padding:14px 12px; text-align:left; width:240px; font-weight:700;">Área Unificada</th><th style="padding:14px 12px; text-align:left; min-width:300px; font-weight:700;">Competencias Consolidadas</th>`;
        window.alumnoSeleccionadoActual.periodos.forEach(p => {
            const th = document.createElement('th');
            th.style.padding = '14px 12px'; th.style.textAlign = 'center'; th.style.background = '#e2e8f0'; th.style.color = '#0f172a'; th.style.width = '110px';
            th.innerText = p.nombre_periodo;
            theadRow.appendChild(th);
        });

        let htmlHtml = '';
        
        // Identificar los cursos que NO entran en ninguna fusión para listarlos de forma independiente
        let cursosEnFusiones = [];
        window.rulesFusionesCursos.forEach(r => { cursosEnFusiones = cursosEnFusiones.concat(r.cursosIds); });

        // --- PROCESAR BLOQUE 1: ÁREAS CONFIGURADAS POR EL ADMIN ---
        window.rulesFusionesCursos.forEach(regla => {
            // Filtrar las asignaciones del salón que corresponden a los cursos de esta regla
            const asignacionesArea = window.alumnoSeleccionadoActual.asignaciones.filter(a => regla.cursosIds.includes(Number(a.id_curso)));
            if (asignacionesArea.length === 0) return; // Si el grado no lleva estos cursos, saltar

            // Mapear todas las competencias de todos los cursos vinculados a esta área
            let competenciasArea = [];
            asignacionesArea.forEach(asig => {
                const comps = window.alumnoSeleccionadoActual.competencias.filter(c => c.id_curso == asig.id_curso);
                competenciasArea.push({ id_asignacion: asig.id_asignacion, id_curso: asig.id_curso, listaComps: comps });
            });

            if (regla.promediar) {
                // METODOLOGÍA A: PROMEDIAR COMPETENCIAS HOMÓLOGAS POR ORDEN DE ÍNDICE
                // Buscamos el número máximo de competencias de entre los cursos a promediar
                const maxCompetencias = Math.max(...competenciasArea.map(c => c.listaComps.length), 0);

                for (let i = 0; i < maxCompetencias; i++) {
                    htmlHtml += `<tr style="border-bottom:1px solid #e2e8f0; background:#fff;">`;
                    if (i === 0) htmlHtml += `<td rowspan="${maxCompetencias}" style="padding:12px; font-weight:700; color:#0f172a; border-right:1px solid #e2e8f0; background:#f8fafc; vertical-align:middle;">${regla.nombre} <br><small style="color:#22c55e; font-weight:bold;">[Promediado]</small></td>`;

                    htmlHtml += `<td style="padding:10px 12px; color:#334155; font-weight:600; border-right:1px solid #f1f5f9;">Competencia Consolidada N° ${i + 1}</td>`;

                    // Calcular promedio decimal para cada periodo académico
                    window.alumnoSeleccionadoActual.periodos.forEach(p => {
                        let sumaDecimales = 0;
                        let contadorNotasValidas = 0;

                        competenciasArea.forEach(cArea => {
                            const compEspecifica = cArea.listaComps[i];
                            if (compEspecifica) {
                                const notaReg = window.alumnoSeleccionadoActual.calificaciones.find(n => n.id_asignacion == cArea.id_asignacion && n.id_periodo == p.id_periodo && n.id_competencia == compEspecifica.id_competencia);
                                if (notaReg && notaReg.id_escala) {
                                    // Buscar el valor decimal correspondiente de la escala cargada de la BD
                                    const escalaObj = window.evalEscalasCalificacion.find(e => e.id_escala == notaReg.id_escala);
                                    if (escalaObj && escalaObj.valor_decimal !== undefined) {
                                        sumaDecimales += Number(escalaObj.valor_decimal);
                                        contadorNotasValidas++;
                                    }
                                }
                            }
                        });

                        htmlHtml += `<td style="padding:6px; text-align:center; border-right:1px solid #f1f5f9;">`;
                        if (contadorNotasValidas > 0) {
                            const promedioFinal = sumaDecimales / contadorNotasValidas;
                            const letraEquivalente = calcularEscalaPorPromedioDecimal(promedioFinal);
                            htmlHtml += `<span class="badge-nota-view nota-${letraEquivalente.toLowerCase()}" title="Promedio decimal: ${promedioFinal.toFixed(2)}">${letraEquivalente}</span>`;
                        } else {
                            htmlHtml += `<span class="sin-nota">─</span>`;
                        }
                        htmlHtml += `</td>`;
                    });
                    htmlHtml += `</tr>`;
                }

            } else {
                // METODOLOGÍA B: UNIFICAR BAJO EL MISMO CURSO PERO MOSTRAR CADA COMPETENCIA INDEPENDIENTE
                // Contamos el total de competencias sumadas de todos los cursos del área
                const totalCompsUnificadas = competenciasArea.reduce((acc, current) => acc + current.listaComps.length, 0);
                let compContadorGlobal = 0;

                competenciasArea.forEach(cArea => {
                    cArea.listaComps.forEach(comp => {
                        htmlHtml += `<tr style="border-bottom:1px solid #f1f5f9; background:#fff;">`;
                        if (compContadorGlobal === 0) htmlHtml += `<td rowspan="${totalCompsUnificadas}" style="padding:12px; font-weight:700; color:#0f172a; border-right:1px solid #e2e8f0; background:#f8fafc; vertical-align:middle;">${regla.nombre} <br><small style="color:#0284c7; font-weight:bold;">[Unificado]</small></td>`;

                        htmlHtml += `<td style="padding:10px 12px; color:#475569; border-right:1px solid #f1f5f9; font-size:0.82rem;"><strong style="color:#64748b;">C${compContadorGlobal + 1}:</strong> ${comp.descripcion_competencia}</td>`;

                        window.alumnoSeleccionadoActual.periodos.forEach(p => {
                            const notaReg = window.alumnoSeleccionadoActual.calificaciones.find(n => n.id_asignacion == cArea.id_asignacion && n.id_periodo == p.id_periodo && n.id_competencia == comp.id_competencia);
                            matrixHtml = `<td style="padding:6px; text-align:center; border-right:1px solid #f1f5f9;">${notaReg ? `<span class="badge-nota-view nota-${notaReg.id_escala.toLowerCase()}">${notaReg.id_escala}</span>` : '<span class="sin-nota">─</span>'}</td>`;
                            htmlHtml += matrixHtml;
                        });

                        compContadorGlobal++;
                        htmlHtml += `</tr>`;
                    });
                });
            }
        });

        // --- PROCESAR BLOQUE 2: CURSOS INDEPENDIENTES (FUERA DE FUSIONES) ---
        window.alumnoSeleccionadoActual.asignaciones.forEach(asig => {
            if (cursosEnFusiones.includes(Number(asig.id_curso))) return; // Omitir si ya está mapeado arriba

            const nombreCurso = asig.cursos?.nombre_curso || 'Curso';
            const compsDelCurso = window.alumnoSeleccionadoActual.competencias.filter(c => c.id_curso == asig.id_curso);

            compsDelCurso.forEach((comp, idx) => {
                htmlHtml += `<tr style="border-bottom:1px solid #f1f5f9; background:#fff;">`;
                if (idx === 0) htmlHtml += `<td rowspan="${compsDelCurso.length}" style="padding:12px; font-weight:600; color:#475569; border-right:1px solid #e2e8f0; vertical-align:middle; background:#fafafa;">${nombreCurso}</td>`;
                
                htmlHtml += `<td style="padding:10px 12px; color:#475569; border-right:1px solid #f1f5f9; font-size:0.82rem;"><strong style="color:#64748b;">C${idx+1}:</strong> ${comp.descripcion_competencia}</td>`;

                window.alumnoSeleccionadoActual.periodos.forEach(p => {
                    const nota = window.alumnoSeleccionadoActual.calificaciones.find(n => n.id_asignacion == asig.id_asignacion && n.id_periodo == p.id_periodo && n.id_competencia == comp.id_competencia);
                    htmlHtml += `<td style="padding:6px; text-align:center; border-right:1px solid #f1f5f9;">${nota ? `<span class="badge-nota-view nota-${nota.id_escala.toLowerCase()}">${nota.id_escala}</span>` : '<span class="sin-nota">─</span>'}</td>`;
                });
                htmlHtml += `</tr>`;
            });
        });

        tbody.innerHTML = htmlHtml || '<tr><td colspan="10" style="text-align:center; padding:20px; color:#64748b;">No hay asignaciones para estructurar.</td></tr>';
    }

    
    /**
     * 5. Restablece el buscador y la vista.
     */
    function limpiarBusquedaProgreso() {
        const input = document.getElementById('progreso-buscar-input');
        input.value = '';
        input.focus();
        
        document.getElementById('progreso-clear-search').style.display = 'none';
        document.getElementById('progreso-resultados-flotantes').style.display = 'none';
        document.getElementById('progreso-tabla-contenedor').style.display = 'none';
        document.getElementById('progreso-empty-state').style.display = 'block';
    }

    // Cerrar sugerencias al dar clic en la periferia externa
    document.addEventListener('click', function(e) {
        const panel = document.getElementById('progreso-resultados-flotantes');
        const input = document.getElementById('progreso-buscar-input');
        if (panel && e.target !== panel && e.target !== input) {
            panel.style.display = 'none';
        }
    });


    //====================================================================================//
    // =================================================================
    // ADICIÓN: EMISIÓN MASIVA DE INFORMES DE PROGRESO POR SECCIÓN (A4)
    // =================================================================

    // Variable global para almacenar la cola ordenada de cursos antes de guardar la regla
    window.tmpCursosIdsOrdenados = [];


    // =================================================================
    // ENGINE GESTOR DE TRIPLE PESTAÑA PRINCIPAL (PERSISTENCIA SUPABASE)
    // =================================================================

    window.padronEstudiantesProgreso = [];
    window.alumnoSeleccionadoActual = null;
    window.rulesFusionesCursos = [];     // Ahora se poblará dinámicamente desde Supabase
    window.catalogoCursosCache = [];     // Caché global para traducción veloz de nombres
    window.idRuleFusionEditando = null;  // Almacena el ID del registro que se está editando

    /**
     * Gobierna el intercambio de los 3 entornos principales de jerarquía superior
     */
    async function cambiarMainTabProgreso(tipoEntorno) {
        document.getElementById('btn-main-tab-individual').classList.remove('active');
        document.getElementById('btn-main-tab-seccion').classList.remove('active');
        document.getElementById('btn-main-tab-config').classList.remove('active');
        
        document.getElementById('entorno-progreso-individual').style.display = 'none';
        document.getElementById('entorno-progreso-seccion').style.display = 'none';
        document.getElementById('entorno-progreso-config').style.display = 'none';

        if (tipoEntorno === 'individual') {
            document.getElementById('btn-main-tab-individual').classList.add('active');
            document.getElementById('entorno-progreso-individual').style.display = 'block';
        } else if (tipoEntorno === 'seccion') {
            document.getElementById('btn-main-tab-seccion').classList.add('active');
            document.getElementById('entorno-progreso-seccion').style.display = 'block';
        } else if (tipoEntorno === 'config') {
            document.getElementById('btn-main-tab-config').classList.add('active');
            document.getElementById('entorno-progreso-config').style.display = 'block';
            inicializarTabConfigFusiones();
        }
    }

    /**
     * Carga el catálogo base de Supabase e inicializa el entorno de configuración
     */
    async function inicializarTabConfigFusiones() {
        const selectCursos = document.getElementById('cfg-fusion-cursos-select');
        if (!selectCursos) return;

        selectCursos.innerHTML = '<option value="">Sincronizando catálogo completo de cursos...</option>';
        resetearFormularioFusion();

        try {
            if (!window.evalAnioActivo) {
                const { data: anioReg, error: errA } = await supabaseClient.from('anio_academico').select('*').eq('estado', 'ACTIVO').single();
                if (errA) throw errA;
                window.evalAnioActivo = anioReg;
            }

            // 1. Descargar catálogo maestro de cursos para el año lectivo
            const { data: catalogoCursos, error: errC } = await supabaseClient
                .from('cursos')
                .select('id_curso, nombre_curso')
                .order('nombre_curso', { ascending: true });

            if (errC) throw errC;
            window.catalogoCursosCache = catalogoCursos || [];

            let optionsHtml = '<option value="">Elija un curso de la lista...</option>';
            window.catalogoCursosCache.forEach(c => {
                optionsHtml += `<option value="${c.id_curso}">${c.nombre_curso.toUpperCase()}</option>`;
            });
            selectCursos.innerHTML = optionsHtml;

            // 2. Descargar de forma reactiva las reglas de la base de datos
            await cargarFusionesDesdeSupabase();

        } catch (err) {
            console.error("Error al poblar catálogo global de fusiones:", err.message);
            selectCursos.innerHTML = '<option value="">Error al sincronizar cursos.</option>';
        }
    }

    /**
     * Descarga las fusiones de Supabase y las mapea al formato de la app
     */
    async function cargarFusionesDesdeSupabase() {
        try {
            const { data, error } = await supabaseClient
                .from('config_fusiones')
                .select('*')
                .eq('id_anio', window.evalAnioActivo.id_anio)
                .order('id_fusion', { ascending: true });

            if (error) throw error;

            // Mapeo seguro al formato existente para mantener intactos los motores de PDF e individual
            window.rulesFusionesCursos = (data || []).map(item => ({
                id: item.id_fusion,
                nombre: item.nombre_fusion,
                cursosIds: item.cursos_ids || [],
                promediar: item.promediar
            }));

            renderizarListadoReglasConfig();
        } catch (err) {
            console.error("Error cargando fusiones desde Supabase:", err.message);
        }
    }

    /**
     * Renderiza el listado de reglas activas e integra los disparadores CRUD
     */
    function renderizarListadoReglasConfig() {
        const contenedor = document.getElementById('lista-reglas-fusion-contenedor');
        if (!contenedor) return;

        if (window.rulesFusionesCursos.length === 0) {
            contenedor.innerHTML = `
                <div style="text-align:center; padding:20px; background:#ffffff; border:1px dashed #cbd5e1; border-radius:8px; color:#94a3b8; font-size:0.85rem; font-weight:600;">
                    No se registran reglas de unificación en el año actual. Todo se procesará por asignaturas independientes.
                </div>`;
            return;
        }

        contenedor.innerHTML = window.rulesFusionesCursos.map(r => `
            <div class="fusion-rule-item" style="background:#ffffff; border:1px solid #cbd5e1; box-shadow:0 1px 3px rgba(0,0,0,0.02); padding: 12px; display: flex; justify-content: space-between; align-items: center; border-radius: 8px; margin-bottom: 8px;">
                <div class="rule-info-left">
                    <h5 style="color:#0f172a; font-weight:700; margin:0; font-size:0.9rem;">${r.nombre}</h5>
                    <p style="color:#64748b; font-weight:600; margin:2px 0 0 0; font-size:0.78rem;">Estrategia: <span style="color:#0284c7;">${r.promediar ? 'Promediar Competencias' : 'Mantener Separadas'}</span> | Cursos en regla: ${r.cursosIds.length}</p>
                </div>
                <div style="display: flex; gap: 6px;">
                    <button type="button" onclick="editarReglaFusion(${r.id})" style="color:#0284c7; background:#e0f2fe; border:none; border-radius:6px; width:34px; height:34px; display:flex; align-items:center; justify-content:center; cursor:pointer;" title="Editar regla">
                        <span class="material-symbols-outlined" style="font-size:18px;">edit</span>
                    </button>
                    <button type="button" onclick="eliminarReglaFusion(${r.id})" style="color:#ef4444; background:#fee2e2; border:none; border-radius:6px; width:34px; height:34px; display:flex; align-items:center; justify-content:center; cursor:pointer;" title="Eliminar regla">
                        <span class="material-symbols-outlined" style="font-size:18px;">delete</span>
                    </button>
                </div>
            </div>
        `).join('');
    }

    /**
     * NUEVO: Extrae los datos de la regla y monta el estado de edición en el formulario
     */
    function editarReglaFusion(idRegla) {
        const regla = window.rulesFusionesCursos.find(r => r.id === idRegla);
        if (!regla) return;

        window.idRuleFusionEditando = idRegla;

        // Cargar campos primarios
        document.getElementById('cfg-fusion-nombre').value = regla.nombre;
        document.getElementById('cfg-fusion-metodo').value = regla.promediar ? 'promediar' : 'separar';

        // Reconstruir la cola temporal cruzando contra el caché global
        window.tmpCursosIdsOrdenados = regla.cursosIds.map(cId => {
            const cursoObj = window.catalogoCursosCache.find(c => c.id_curso == cId);
            return {
                id: cId,
                nombre: cursoObj ? cursoObj.nombre_curso.toUpperCase() : `CURSO ASIGNADO ID: ${cId}`
            };
        });

        renderizerCursosTemporalesOrden();

        // Cambiar estilización del botón de acción principal para indicar actualización
        const btnGuardar = document.querySelector('#entorno-progreso-config button[onclick="guardarReglaFusion()"]');
        if (btnGuardar) {
            btnGuardar.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">published_with_changes</span> Actualizar Fusión Curricular`;
            btnGuardar.style.background = '#0284c7';
            btnGuardar.style.borderColor = '#0284c7';
        }
    }

    /**
     * Procesa de forma inteligente inserciones (Insert) o modificaciones (Update) en Supabase
     */
    async function guardarReglaFusion() {
        const nombre = document.getElementById('cfg-fusion-nombre').value.trim();
        const metodo = document.getElementById('cfg-fusion-metodo').value;

        if (!nombre || window.tmpCursosIdsOrdenados.length === 0) {
            return alert("Por favor, estipule un nombre para el área y asocie al menos una asignatura en la cola.");
        }

        const cursosIds = window.tmpCursosIdsOrdenados.map(c => c.id);
        const promediar = (metodo === 'promediar');

        try {
            if (window.idRuleFusionEditando) {
                // OPERACIÓN A: ACTUALIZAR REGISTRO EXISTENTE (UPDATE)
                const { error } = await supabaseClient
                    .from('config_fusiones')
                    .update({
                        nombre_fusion: nombre,
                        cursos_ids: cursosIds,
                        promediar: promediar
                    })
                    .eq('id_fusion', window.idRuleFusionEditando);

                if (error) throw error;
                alert("Estructura de unificación actualizada exitosamente en el servidor.");
            } else {
                // OPERACIÓN B: INSERTAR NUEVO REGISTRO (INSERT)
                const { error } = await supabaseClient
                    .from('config_fusiones')
                    .insert([{
                        nombre_fusion: nombre,
                        cursos_ids: cursosIds,
                        promediar: promediar,
                        id_anio: window.evalAnioActivo.id_anio
                    }]);

                if (error) throw error;
                alert("Estructura de unificación añadida exitosamente al sistema.");
            }

            // Restablecer entorno y refrescar datos desde la BD
            resetearFormularioFusion();
            await cargarFusionesDesdeSupabase();
            await cargarOrdenGlobalDesdeSupabase();

        } catch (err) {
            console.error("Error al guardar la fusión en Supabase:", err.message);
            alert("No se pudo guardar la regla en el servidor: " + err.message);
        }
    }

    /**
     * Elimina de forma definitiva la regla de la base de datos
     */
    async function eliminarReglaFusion(idRegla) {
        if (!confirm("¿Está seguro de que desea eliminar esta regla de unificación? Esto afectará los reportes consolidados.")) return;

        try {
            const { error } = await supabaseClient
                .from('config_fusiones')
                .delete()
                .eq('id_fusion', idRegla);

            if (error) throw error;

            alert("Regla eliminada del servidor.");
            if (window.idRuleFusionEditando === idRegla) resetearFormularioFusion();
            await cargarFusionesDesdeSupabase();
            await cargarOrdenGlobalDesdeSupabase();
        } catch (err) {
            console.error("Error al eliminar fusión de Supabase:", err.message);
            alert("No se pudo eliminar el registro: " + err.message);
        }
    }

    /**
     * Restablece los campos de control del formulario y limpia estados de edición
     */
    function resetearFormularioFusion() {
        window.idRuleFusionEditando = null;
        window.tmpCursosIdsOrdenados = [];
        
        document.getElementById('cfg-fusion-nombre').value = '';
        const selectMetodo = document.getElementById('cfg-fusion-metodo');
        if (selectMetodo) selectMetodo.value = 'promediar';

        renderizerCursosTemporalesOrden();

        const btnGuardar = document.querySelector('#entorno-progreso-config button[onclick="guardarReglaFusion()"]');
        if (btnGuardar) {
            btnGuardar.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">add_box</span> Registrar Fusión Curricular`;
            btnGuardar.style.background = '#22c55e';
            btnGuardar.style.borderColor = '#22c55e';
        }
    }

    //==========================================================================================
    /**
     * Añade un elemento a la cola y renderiza sus controles jerárquicos
     */
    function agregarCursoAreglaTemporal() {
        const select = document.getElementById('cfg-fusion-cursos-select');
        const idCurso = Number(select.value);
        const nombreCurso = select.options[select.selectedIndex]?.text;

        if (!idCurso) return alert("Por favor, seleccione un curso válido del desplegable.");

        // Evitar duplicaciones en el mismo bloque
        if (window.tmpCursosIdsOrdenados.some(c => c.id == idCurso)) {
            return alert("Esta asignatura ya forma parte de la regla en construcción.");
        }

        window.tmpCursosIdsOrdenados.push({ id: idCurso, nombre: nombreCurso });
        renderizerCursosTemporalesOrden();
        select.value = ''; // Resetear selector
    }

    /**
     * Renderiza la lista con botones de desplazamiento de prioridad
     */
    function renderizerCursosTemporalesOrden() {
        const contenedor = document.getElementById('cfg-cursos-seleccionados-orden');
        if (!contenedor) return;

        if (window.tmpCursosIdsOrdenados.length === 0) {
            contenedor.innerHTML = '<span style="color:#94a3b8; font-size:0.8rem; font-style:italic; text-align:center; padding:10px 0;">No hay asignaturas encoladas. Use el control superior para definir la secuencia.</span>';
            return;
        }

        contenedor.innerHTML = window.tmpCursosIdsOrdenados.map((c, idx) => `
            <div style="display:flex; justify-content:space-between; align-items:center; background:#ffffff; padding:8px 12px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.82rem; font-weight:600; box-shadow:0 1px 2px rgba(0,0,0,0.01);">
                <span style="color:#0f172a;"><strong style="color:#0284c7;">Prioridad ${idx + 1}:</strong> ${c.nombre}</span>
                <div style="display:flex; gap:3px;">
                    <button type="button" onclick="moverCursoTemporal(${idx}, -1)" style="padding:3px 8px; cursor:pointer; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:4px; font-weight:700;" ${idx === 0 ? 'disabled style="opacity:0.4; cursor:default;"' : ''}>↑</button>
                    <button type="button" onclick="moverCursoTemporal(${idx}, 1)" style="padding:3px 8px; cursor:pointer; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:4px; font-weight:700;" ${idx === window.tmpCursosIdsOrdenados.length - 1 ? 'disabled style="opacity:0.4; cursor:default;"' : ''}>↓</button>
                    <button type="button" onclick="eliminarCursoTemporal(${idx})" style="padding:3px 8px; cursor:pointer; background:#fee2e2; border:1px solid #fca5a5; color:#ef4444; border-radius:4px; font-weight:700; margin-left:4px;">✕</button>
                </div>
            </div>
        `).join('');
    }

    function moverCursoTemporal(index, direccion) {
        const nuevoIndex = index + direccion;
        if (nuevoIndex < 0 || nuevoIndex >= window.tmpCursosIdsOrdenados.length) return;
        
        // Intercambio de posiciones posicionales
        const temp = window.tmpCursosIdsOrdenados[index];
        window.tmpCursosIdsOrdenados[index] = window.tmpCursosIdsOrdenados[nuevoIndex];
        window.tmpCursosIdsOrdenados[nuevoIndex] = temp;
        
        renderizerCursosTemporalesOrden();
    }

    function eliminarCursoTemporal(index) {
        window.tmpCursosIdsOrdenados.splice(index, 1);
        renderizerCursosTemporalesOrden();
    }
 

    function cambiarSubTabProgreso(tabName) {
        document.getElementById('btn-progreso-tab-general').classList.remove('active');
        document.getElementById('btn-progreso-tab-fusionado').classList.remove('active');
        document.getElementById('vista-progreso-general').style.display = 'none';
        document.getElementById('vista-progreso-fusionado').style.display = 'none';

        if (tabName === 'general') {
            document.getElementById('btn-progreso-tab-general').classList.add('active');
            document.getElementById('vista-progreso-general').style.display = 'block';
        } else {
            document.getElementById('btn-progreso-tab-fusionado').classList.add('active');
            document.getElementById('vista-progreso-fusionado').style.display = 'block';
            if (window.alumnoSeleccionadoActual) {
                compilarYRenderizarMatrizFusionada();
            }
        }
    }


    /**
     * Carga los grados del nivel seleccionado en la pestaña Sección
     */
    function cargarGradosProgresoSec() {
        const nivel = document.getElementById('progreso-sec-nivel').value;
        const gradoSelect = document.getElementById('progreso-sec-grado');
        const secSelect = document.getElementById('progreso-sec-seccion');
        
        gradoSelect.innerHTML = '<option value="">Seleccione...</option>';
        secSelect.innerHTML = '<option value="">Seleccione...</option>';
        secSelect.disabled = true;

        if (!nivel) {
            gradoSelect.disabled = true;
            return;
        }

        const grados = nivel === 'Primaria' ? ['1°', '2°', '3°', '4°', '5°', '6°'] : ['1°', '2°', '3°', '4°', '5°'];
        grados.forEach(g => {
            const opt = document.createElement('option');
            opt.value = g; opt.textContent = g;
            gradoSelect.appendChild(opt);
        });
        gradoSelect.disabled = false;
    }

    /**
     * Consulta a Supabase las secciones existentes para poblar el combo
     */
    async function cargarSeccionesProgresoSec() {
        const nivel = document.getElementById('progreso-sec-nivel').value;
        const grado = document.getElementById('progreso-sec-grado').value;
        const secSelect = document.getElementById('progreso-sec-seccion');

        secSelect.innerHTML = '<option value="">Seleccione...</option>';

        if (!nivel || !grado) {
            secSelect.disabled = true;
            return;
        }

        try {
            const { data, error } = await supabaseClient
                .from('secciones')
                .select('id_sec, nombre_sec')
                .eq('nivel', nivel)
                .eq('grado', grado)
                .eq('id_anio', window.evalAnioActivo.id_anio);

            if (error) throw error;

            data?.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id_sec; opt.textContent = `Sección "${s.nombre_sec}"`;
                secSelect.appendChild(opt);
            });
            secSelect.disabled = false;

        } catch (err) {
            console.error("Error al cargar secciones de progreso:", err.message);
        }
    }


    /**
     * MOTOR CORE OPTIMIZADO: Genera el PDF masivo en formato A4 vertical
     * Ajustes estructurales: Título arriba de todo, insignia a la izquierda con datos de la IE al lado, 
     * cuadro de estudiante sin línea divisoria horizontal y sello de Dirección por encima de la línea inferior.
     */
    async function generarInformeProgresoSeccionPDF() {
        const idSec = document.getElementById('progreso-sec-seccion').value;
        const nivel = document.getElementById('progreso-sec-nivel').value;
        const grado = document.getElementById('progreso-sec-grado').value;

        if (!idSec || !nivel || !grado) {
            return alert("Por favor, establezca todos los filtros obligatorios de la sección antes de compilar.");
        }

        window.alert("Iniciando compilación masiva del aula. El proceso puede tomar unos segundos debido al cruce analítico de calificaciones. Presione aceptar para comenzar.");

        try {
            const anioLectivo = window.evalAnioActivo?.nombre_anio || '2026';
            const codigoModular = (nivel === 'Primaria') ? '1662360' : '1518554';

            // 1. Descarga en paralelo incluyendo escalas de calificación y la secuencia de ordenamiento del PDF
            const [resMatriculas, resAsignaciones, resPeriodos, resNotas, resEscalas, resOrdenPDF] = await Promise.all([
                supabaseClient.from('matriculas').select('id_est, estudiantes(id_est, apellido_paterno, apellido_materno, nombres, dni)').eq('id_sec', idSec).eq('estado', 'ACTIVO'),
                supabaseClient.from('cursos_asignados').select('id_asignacion, id_curso, cursos!fk_cursos(nombre_curso)').eq('id_sec', idSec).eq('id_anio', window.evalAnioActivo.id_anio),
                supabaseClient.from('periodos_evaluacion').select('id_periodo, nombre_periodo').eq('id_anio', window.evalAnioActivo.id_anio).order('fecha_inicio', { ascending: true }),
                supabaseClient.from('calificaciones').select('id_est, id_asignacion, id_periodo, id_competencia, id_escala').in('id_asignacion', 
                    (await supabaseClient.from('cursos_asignados').select('id_asignacion').eq('id_sec', idSec).eq('id_anio', window.evalAnioActivo.id_anio)).data.map(a => a.id_asignacion)
                ),
                window.evalEscalasCalificacion ? Promise.resolve({ data: window.evalEscalasCalificacion }) : supabaseClient.from('escalas_calificacion').select('*'),
                supabaseClient.from('config_orden_pdf').select('orden_elementos, elementos_ocultos').eq('id_anio', window.evalAnioActivo.id_anio).maybeSingle()
            ]);

            if (resMatriculas.error) throw resMatriculas.error;
            if (resAsignaciones.error) throw resAsignaciones.error;
            if (resPeriodos.error) throw resPeriodos.error;
            if (resNotas.error) throw resNotas.error;
            if (resEscalas.error) throw resEscalas.error;
            if (resOrdenPDF.error) throw resOrdenPDF.error;

            window.evalEscalasCalificacion = resEscalas.data || [];
            const dbOrdenPDF = resOrdenPDF.data ? (resOrdenPDF.data.orden_elementos || []) : [];
            const dbOcultosPDF = resOrdenPDF.data ? (resOrdenPDF.data.elementos_ocultos || []) : [];

            const alumnos = (resMatriculas.data || []).map(m => ({
                id_est: m.id_est || m.estudiantes?.id_est,
                dni: m.estudiantes?.dni || '────────',
                nombre_completo: `${m.estudiantes?.apellido_paterno || ''} ${m.estudiantes?.apellido_materno || ''}, ${m.estudiantes?.nombres || ''}`.toUpperCase().trim()
            })).sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo));

            const asignaciones = resAsignaciones.data || [];
            const periodos = resPeriodos.data || [];
            const calificacionesTodas = resNotas.data || [];

            if (alumnos.length === 0) return alert("El aula seleccionada no registra estudiantes con matrícula ACTIVA.");

            const { data: competencias, error: errC } = await supabaseClient
                .from('competencias')
                .select('id_competencia, id_curso, descripcion_competencia')
                .in('id_curso', asignaciones.map(a => a.id_curso))
                .order('id_competencia', { ascending: true });

            if (errC) throw errC;

            let printWindow = window.open('', '_blank');
            let htmlPrint = `
                <html>
                <head>
                    <title>Informes Consolidados - Sección ${grado}</title>
                    <style>
                        @import url('https://fonts.googleapis.com/css2?family=Anek+Latin:wght@400;500;600;700&display=swap');
                        body { font-family: 'Anek Latin', sans-serif; margin: 0; padding: 0; background: #ffffff; color: #1e293b; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                        .report-page { width: 210mm; min-height: 296mm; padding: 5mm 10mm; margin: 0 auto; box-sizing: border-box; background: #ffffff; border-bottom: 2px dashed #cbd5e1; position: relative; }
                        @media print { .report-page { border-bottom: none; page-break-after: always; break-after: page; } }
                        
                        /* CORREGIDO: Estructura de cabecera limpia sin líneas horizontales divisorias */
                        .ie-header-row { display: flex; gap: 15px; align-items: center; margin-bottom: 12px; width: 100%; }
                        .institution-title h2 { margin: 0; font-size: 1.1rem; color: #29438F; font-weight: 700; text-transform: uppercase; }
                        .institution-title p { margin: 1px 0 0 0; font-size: 0.75rem; color: #64748b; font-weight: 600; }
                        .doc-title { text-align: center; font-size: 0.95rem; font-weight: 700; color: #ffffff; background: #29438F; padding: 6px; border-radius: 6px; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
                        
                        .student-meta-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 6px 15px; background: #f8fafc; padding: 8px 12px; border-radius: 10px; border: 1px solid #e2e8f0; margin-bottom: 14px; box-sizing: border-box; }
                        .meta-label { color: #64748b; font-weight: 600; text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.5px; }
                        .meta-value { color: #29438F; font-weight: 700; margin-top: 1px; }
                        
                        .header-insignia { width: 70px; height: 70px; object-fit: contain; mix-blend-mode: multiply; }
                        
                        table.table-pdf { width: 100%; border-collapse: separate; border-spacing: 0; margin-bottom: 6px; font-size: 0.78rem; border: 1px solid #29438F; border-radius: 10px; overflow: hidden; }
                        table.table-pdf th { background: #29438F; color: #ffffff; padding: 6px 4px; font-weight: 700; text-align: center; border: none; font-size: 0.75rem; text-transform: uppercase; border-bottom: 1px solid #29438F; }
                        table.table-pdf td { padding: 2px 6px; border-bottom: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; color: #334155; line-height: 1.25; vertical-align: middle; }
                        table.table-pdf td:last-child { border-right: none; }
                        
                        .badge-pdf-nota { display: inline-block; font-weight: 800; font-size: 0.85rem; color: #0f172a; text-align: center; }
                        
                        .legend-container { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 6px 12px; margin-bottom: 10px; font-size: 0.7rem; color: #475569; font-weight: 600; display: flex; gap: 15px; align-items: center; }
                        .legend-title { color: #29438F; font-weight: 700; text-transform: uppercase; font-size: 0.68rem; }
                        
                        /* CORREGIDO: Clases independientes para aislar el Sello y colocarlo POR ENCIMA de la línea */
                        .seal-floating-wrapper { position: absolute; bottom: 14mm; right: 10mm; display: flex; flex-direction: column; align-items: center; text-align: center; width: 140px; }
                        .seal-img { width: 110px; height: auto; margin-bottom: -2px; mix-blend-mode: multiply; }
                        .seal-label { font-size: 0.68rem; color: #475569; font-weight: 700; border-top: 1px solid #cbd5e1; width: 100%; padding-top: 2px; text-transform: uppercase; letter-spacing: 0.3px; }
                        
                        .footer-pdf-bar { position: absolute; bottom: 6mm; left: 10mm; right: 10mm; border-top: 1px solid #e2e8f0; padding-top: 6px; display: flex; justify-content: space-between; font-size: 0.7rem; color: #94a3b8; font-weight: 600; }
                    </style>
                </head>
                <body>
            `;

            let cursosEnFusiones = [];
            window.rulesFusionesCursos.forEach(r => { cursosEnFusiones = cursosEnFusiones.concat(r.cursosIds); });

            // 4. CICLO DE COMPILACIÓN: Generar un folio A4 independiente por estudiante
            alumnos.forEach(alumno => {
                const notasAlumno = calificacionesTodas.filter(n => n.id_est == alumno.id_est);

                htmlPrint += `
                    <div class="report-page">
                        <div class="doc-title">
                            Informe de Progreso del Aprendizaje del Estudiante ${anioLectivo}
                        </div>

                        <div class="ie-header-row">
                            <img src="https://i.postimg.cc/Z5zvmYcM/logo-Newton-ticket-PDF.jpg" class="header-insignia" alt="Insignia Corp">
                            <div style="flex: 1; display: flex; justify-content: space-between; align-items: center;">
                                <div class="institution-title">
                                    <h2>I.E.P. Ciencias Aplicadas Sir Isaac Newton</h2>
                                    <p>Mollendo • Islay • Arequipa</p>
                                </div>
                                <div style="text-align: right; font-size: 0.75rem; color: #475569; font-weight: 700; line-height: 1.3;">
                                    Código Modular: ${codigoModular}<br>Año Lectivo: ${anioLectivo}
                                </div>
                            </div>
                        </div>

                        <div class="student-meta-grid">
                            <div>
                                <div class="meta-label">Estudiante</div>
                                <div class="meta-value" style="font-size: 0.95rem;">${alumno.nombre_completo}</div>
                            </div>
                            <div>
                                <div class="meta-label">DNI / Código</div>
                                <div class="meta-value">${alumno.dni}</div>
                            </div>
                            <div>
                                <div class="meta-label">Grado y Sección</div>
                                <div class="meta-value">${grado} "${document.getElementById('progreso-sec-seccion').options[document.getElementById('progreso-sec-seccion').selectedIndex].text.replace('Sección ', '').replace(/"/g, '')}"</div>
                            </div>
                            <div>
                                <div class="meta-label">Nivel Educativo</div>
                                <div class="meta-value">${nivel}</div>
                            </div>
                        </div>

                        <table class="table-pdf">
                            <thead>
                                <tr>
                                    <th style="width: 130px; background: #29438F; text-align: center;">ÁREA</th>
                                    <th style="background: #29438F; text-align: center;">Competencias Oficiales del CNEB</th>`;
                
                periodos.forEach(p => {
                    htmlPrint += `<th style="text-align:center; width: 30px; background: #29438F;">${p.nombre_periodo.replace('Bimestre', 'Bim')}</th>`;
                });

                htmlPrint += `
                                </tr>
                            </thead>
                            <tbody>`;

                let fusionesDisponibles = [];
                window.rulesFusionesCursos.forEach(regla => {
                    const tieneAsig = asignaciones.some(a => regla.cursosIds.includes(Number(a.id_curso)));
                    if (tieneAsig) fusionesDisponibles.push({ tipo: 'FUSION', id: regla.id, raw: regla });
                });

                let cursosLibresDisponibles = [];
                asignaciones.forEach(asig => {
                    if (!cursosEnFusiones.includes(Number(asig.id_curso))) {
                        cursosLibresDisponibles.push({ tipo: 'CURSO', id: asig.id_curso, raw: asig });
                    }
                });

                let itemsPlanificadosReporte = [];
                dbOrdenPDF.forEach(key => {
                    const [tipo, idStr] = key.split(':');
                    if (tipo === 'FUSION') {
                        const idx = fusionesDisponibles.findIndex(f => f.id == idStr);
                        if (idx !== -1) { itemsPlanificadosReporte.push(fusionesDisponibles[idx]); fusionesDisponibles.splice(idx, 1); }
                    } else if (tipo === 'CURSO') {
                        const idx = cursosLibresDisponibles.findIndex(c => c.id == idStr);
                        if (idx !== -1) { itemsPlanificadosReporte.push(cursosLibresDisponibles[idx]); cursosLibresDisponibles.splice(idx, 1); }
                    }
                });
                
                let ordenFinalReporte = itemsPlanificadosReporte.concat(fusionesDisponibles).concat(cursosLibresDisponibles);

                ordenFinalReporte.forEach(item => {
                    const llaveVisibilidad = `${item.tipo}:${item.id}`;
                    if (dbOcultosPDF.includes(llaveVisibilidad)) return;

                    if (item.tipo === 'FUSION') {
                        const regla = item.raw;
                        let asignacionesArea = [];
                        regla.cursosIds.forEach(cId => {
                            const found = asignaciones.find(a => Number(a.id_curso) == cId);
                            if (found) asignacionesArea.push(found);
                        });
                        if (asignacionesArea.length === 0) return;

                        let competenciasArea = [];
                        asignacionesArea.forEach(asig => {
                            const comps = competencias.filter(c => c.id_curso == asig.id_curso);
                            competenciasArea.push({ id_asignacion: asig.id_asignacion, id_curso: asig.id_curso, listaComps: comps });
                        });

                        if (regla.promediar) {
                            const maxCompetencias = Math.max(...competenciasArea.map(c => c.listaComps.length), 0);
                            const idPrimerCurso = regla.cursosIds[0];
                            const compsPrimerCurso = competencias.filter(c => c.id_curso == idPrimerCurso);

                            for (let i = 0; i < maxCompetencias; i++) {
                                const isLastRow = (i === maxCompetencias - 1);
                                const thickBorderStyle = isLastRow ? 'border-bottom: 2px solid #94a3b8 !important;' : '';

                                htmlPrint += `<tr>`;
                                if (i === 0) htmlPrint += `<td rowspan="${maxCompetencias}" style="font-weight: 700; background:#f8fafc; vertical-align:middle; border-right:2px solid #cbd5e1; border-bottom: 2px solid #94a3b8 !important;"><strong>${regla.nombre}</strong></td>`;
                                
                                let descripcionMostrar = "";
                                if (compsPrimerCurso[i]) {
                                    descripcionMostrar = compsPrimerCurso[i].descripcion_competencia;
                                } else {
                                    for (let cArea of competenciasArea) {
                                        if (cArea.listaComps[i]) { descripcionMostrar = cArea.listaComps[i].descripcion_competencia; break; }
                                    }
                                    if (!descripcionMostrar) descripcionMostrar = `Competencia de Área N° ${i + 1}`;
                                }
                                htmlPrint += `<td style="color:#000000; ${thickBorderStyle}">${descripcionMostrar}</td>`;

                                periodos.forEach(p => {
                                    let sumaDecimales = 0, contador = 0;
                                    competenciasArea.forEach(cArea => {
                                        const compEspecifica = cArea.listaComps[i];
                                        if (compEspecifica) {
                                            const nota = shortcutBuscarNota(notasAlumno, cArea.id_asignacion, p.id_periodo, compEspecifica.id_competencia);
                                            if (nota) {
                                                const escalaObj = window.evalEscalasCalificacion.find(e => e.id_escala == nota);
                                                if (escalaObj) { sumaDecimales += Number(escalaObj.valor_decimal); contador++; }
                                            }
                                        }
                                    });
                                    htmlPrint += `<td style="text-align:center; ${thickBorderStyle}">`;
                                    if (contador > 0) {
                                        const lit = calcularEscalaPorPromedioDecimal(sumaDecimales / contador);
                                        htmlPrint += `<span class="badge-pdf-nota">${lit}</span>`;
                                    } else { htmlPrint += '─'; }
                                    htmlPrint += `</td>`;
                                });
                                htmlPrint += `</tr>`;
                            }
                        } else {
                            const totalComps = competenciasArea.reduce((acc, curr) => acc + curr.listaComps.length, 0);
                            let contadorGlobal = 0;
                            competenciasArea.forEach(cArea => {
                                cArea.listaComps.forEach(comp => {
                                    const isLastRow = (contadorGlobal === totalComps - 1);
                                    const thickBorderStyle = isLastRow ? 'border-bottom: 2px solid #94a3b8 !important;' : '';

                                    htmlPrint += `<tr>`;
                                    if (contadorGlobal === 0) htmlPrint += `<td rowspan="${totalComps}" style="font-weight: 700; background:#f8fafc; vertical-align:middle; border-right:2px solid #cbd5e1; border-bottom: 2px solid #94a3b8 !important;"><strong>${regla.nombre}</strong></td>`;
                                    htmlPrint += `<td style="color:#000000; ${thickBorderStyle}">${comp.descripcion_competencia}</td>`;
                                    periodos.forEach(p => {
                                        const nota = shortcutBuscarNota(notasAlumno, cArea.id_asignacion, p.id_periodo, comp.id_competencia);
                                        htmlPrint += `<td style="text-align:center; ${thickBorderStyle}">${nota ? `<span class="badge-pdf-nota">${nota}</span>` : '─'}</td>`;
                                    });
                                    contadorGlobal++; htmlPrint += `</tr>`;
                                });
                            });
                        }
                    } else if (item.tipo === 'CURSO') {
                        const asig = item.raw;
                        const nombreCurso = asig.cursos?.nombre_curso || 'Curso';
                        const compsDelCurso = competencias.filter(c => c.id_curso == asig.id_curso);

                        compsDelCurso.forEach((comp, idx) => {
                            const isLastRow = (idx === compsDelCurso.length - 1);
                            const thickBorderStyle = isLastRow ? 'border-bottom: 2px solid #94a3b8 !important;' : '';

                            htmlPrint += `<tr>`;
                            if (idx === 0) htmlPrint += `<td rowspan="${compsDelCurso.length}" style="font-weight: 700; color:#334155; background:#fafafa; vertical-align:middle; border-bottom: 2px solid #94a3b8 !important;"><strong>${nombreCurso}</strong></td>`;
                            htmlPrint += `<td style="color:#000000; ${thickBorderStyle}">${comp.descripcion_competencia}</td>`;
                            periodos.forEach(p => {
                                const nota = shortcutBuscarNota(notasAlumno, asig.id_asignacion, p.id_periodo, comp.id_competencia);
                                htmlPrint += `<td style="text-align:center; ${thickBorderStyle}">${nota ? `<span class="badge-pdf-nota">${nota}</span>` : '─'}</td>`;
                            });
                            htmlPrint += `</tr>`;
                        });
                    }
                });

                htmlPrint += `
                            </tbody>
                        </table>

                        <div class="legend-container">
                            <span class="legend-title">Escala de Calificación:</span>
                            <span><strong>AD</strong>: Logro Destacado</span>
                            <span><strong>A</strong>: Logro Previsto</span>
                            <span><strong>B</strong>: En Proceso</span>
                            <span><strong>C</strong>: En Inicio</span>
                        </div>

                        <div class="seal-floating-wrapper">
                            <img src="https://i.postimg.cc/nz5Tbf91/firma-y-sello-direccion.jpg" class="seal-img" alt="Sello Dirección">
                            
                        </div>

                        <div class="footer-pdf-bar">
                            <span>Newton Académico • Sistema Integrado de Gestión Escolar</span>
                        </div>
                    </div>
                `;
            });

            htmlPrint += `</body></html>`;
            printWindow.document.write(htmlPrint);
            printWindow.document.close();

            printWindow.setTimeout(() => { printWindow.print(); }, 600);

        } catch (err) {
            console.error("Fallo general emitiendo PDF masivo:", err);
            alert("Ocurrió un error transaccional al procesar los documentos: " + err.message);
        }
    }

    function shortcutBuscarNota(coleccionNotas, idAsignacion, idPeriodo, idCompetencia) {
        if (!Array.isArray(coleccionNotas)) return null;
        const r = coleccionNotas.find(n => n.id_asignacion == idAsignacion && n.id_periodo == idPeriodo && n.id_competencia == idCompetencia);
        return r ? r.id_escala : null;
    }


    //==============================================================================
    //variables globales y funciones de sincronización
    // para controlar la mezcla ordenada en la memoria activa del navegador
    window.ordenGlobalElementosPDF = []; // Cache dinámico de mezcla ordenada

    /**
     * Modificación en el inicializador del Tab para orquestar la carga del orden global
     */
    async function inicializarTabConfigFusiones() {
        const selectCursos = document.getElementById('cfg-fusion-cursos-select');
        if (!selectCursos) return;

        selectCursos.innerHTML = '<option value="">Sincronizando catálogo completo de cursos...</option>';
        resetearFormularioFusion();

        try {
            if (!window.evalAnioActivo) {
                const { data: anioReg, error: errA } = await supabaseClient.from('anio_academico').select('*').eq('estado', 'ACTIVO').single();
                if (errA) throw errA;
                window.evalAnioActivo = anioReg;
            }

            const { data: catalogoCursos, error: errC } = await supabaseClient
                .from('cursos')
                .select('id_curso, nombre_curso')
                .order('nombre_curso', { ascending: true });

            if (errC) throw errC;
            window.catalogoCursosCache = catalogoCursos || [];

            let optionsHtml = '<option value="">Elija un curso de la lista...</option>';
            window.catalogoCursosCache.forEach(c => {
                optionsHtml += `<option value="${c.id_curso}">${c.nombre_curso.toUpperCase()}</option>`;
            });
            selectCursos.innerHTML = optionsHtml;

            // Cargar fusiones y posteriormente enlazar el orden unificado
            await cargarFusionesDesdeSupabase();
            await cargarOrdenGlobalDesdeSupabase();

        } catch (err) {
            console.error("Error al poblar catálogo global de fusiones:", err.message);
            selectCursos.innerHTML = '<option value="">Error al sincronizar cursos.</option>';
        }
    }

    /**
     * CORREGIDO: Trae el orden y la visibilidad desde Supabase y procesa el estado 'oculto'
     */
    async function cargarOrdenGlobalDesdeSupabase() {
        try {
            const { data: dbOrden, error } = await supabaseClient
                .from('config_orden_pdf')
                .select('orden_elementos, elementos_ocultos')
                .eq('id_anio', window.evalAnioActivo.id_anio)
                .maybeSingle();

            if (error) throw error;
            let listaGuardada = dbOrden ? (dbOrden.orden_elementos || []) : [];
            let listaOcultos = dbOrden ? (dbOrden.elementos_ocultos || []) : [];

            let cursosEnFusiones = [];
            window.rulesFusionesCursos.forEach(r => { cursosEnFusiones = cursosEnFusiones.concat(r.cursosIds); });

            let elementosDisponibles = [];

            // 1. Inyectar fusiones evaluando si están ocultas
            window.rulesFusionesCursos.forEach(r => {
                const key = `FUSION:${r.id}`;
                elementosDisponibles.push({ 
                    tipo: 'FUSION', 
                    id: r.id, 
                    nombre: r.nombre.toUpperCase(),
                    oculto: listaOcultos.includes(key)
                });
            });

            // 2. Inyectar cursos libres evaluando si están ocultos
            window.catalogoCursosCache.forEach(c => {
                if (!cursosEnFusiones.includes(Number(c.id_curso))) {
                    const key = `CURSO:${c.id_curso}`;
                    elementosDisponibles.push({ 
                        tipo: 'CURSO', 
                        id: c.id_curso, 
                        nombre: c.nombre_curso.toUpperCase(),
                        oculto: listaOcultos.includes(key)
                    });
                }
            });

            // 3. Reordenar el lote basándose en la secuencia oficial
            let elementosOrdenados = [];
            listaGuardada.forEach(key => {
                const [tipo, idStr] = key.split(':');
                const index = elementosDisponibles.findIndex(e => e.tipo === tipo && e.id == idStr);
                if (index !== -1) {
                    elementosOrdenados.push(elementosDisponibles[index]);
                    elementosDisponibles.splice(index, 1);
                }
            });

            window.ordenGlobalElementosPDF = elementosOrdenados.concat(elementosDisponibles);
            renderizarPanelOrdenGlobal();

        } catch (err) {
            console.error("Error estructurando el orden analítico del PDF:", err.message);
        }
    }

    /**
     * CORREGIDO: Renderiza las filas incluyendo el botón de mostrar/ocultar y feedback visual
     */
    function renderizarPanelOrdenGlobal() {
        const contenedor = document.getElementById('panel-orden-global-contenedor');
        if (!contenedor) return;

        if (window.ordenGlobalElementosPDF.length === 0) {
            contenedor.innerHTML = '<p style="font-size:0.8rem; color:#64748b; font-style:italic; text-align:center;">No existen registros para ordenar en el año vigente.</p>';
            return;
        }

        contenedor.innerHTML = window.ordenGlobalElementosPDF.map((item, idx) => `
            <div style="display:flex; justify-content:space-between; align-items:center; background:#ffffff; padding:6px 12px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.82rem; font-weight:600; box-shadow:0 1px 2px rgba(0,0,0,0.01); ${item.oculto ? 'opacity: 0.6; background: #f8fafc;' : ''}">
                <span style="color:#0f172a; ${item.oculto ? 'text-decoration: line-through; color: #94a3b8;' : ''}">
                    <span style="background:${item.tipo === 'FUSION' ? '#e0f2fe' : '#f1f5f9'}; color:${item.tipo === 'FUSION' ? '#0369a1' : '#475569'}; padding:2px 6px; border-radius:4px; font-size:0.68rem; margin-right:8px; font-weight:700;">${item.tipo}</span>
                    <strong>Posición ${idx + 1}:</strong> ${item.nombre}
                </span>
                <div style="display:flex; gap:4px; align-items:center;">
                    <button type="button" onclick="toggleVisibilidadElemento(${idx})" style="padding:4px; cursor:pointer; background:${item.oculto ? '#fee2e2' : '#f1f5f9'}; border:1px solid ${item.oculto ? '#fca5a5' : '#cbd5e1'}; color:${item.oculto ? '#ef4444' : '#475569'}; border-radius:4px; display:flex; align-items:center; justify-content:center;" title="${item.oculto ? 'Mostrar en PDF' : 'Ocultar en PDF'}">
                        <span class="material-symbols-outlined" style="font-size:16px;">${item.oculto ? 'visibility_off' : 'visibility'}</span>
                    </button>
                    <button type="button" onclick="moverElementoOrdenGlobal(${idx}, -1)" style="padding:2px 6px; cursor:pointer; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:4px; font-weight:700;" ${idx === 0 ? 'disabled style="opacity:0.4; cursor:default;"' : ''}>↑</button>
                    <button type="button" onclick="moverElementoOrdenGlobal(${idx}, 1)" style="padding:2px 6px; cursor:pointer; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:4px; font-weight:700;" ${idx === window.ordenGlobalElementosPDF.length - 1 ? 'disabled style="opacity:0.4; cursor:default;"' : ''}>↓</button>
                </div>
            </div>
        `).join('');
    }

    /**
     * NUEVO: Conmuta el estado de visibilidad del elemento seleccionado
     */
    function toggleVisibilidadElemento(index) {
        window.ordenGlobalElementosPDF[index].oculto = !window.ordenGlobalElementosPDF[index].oculto;
        renderizarPanelOrdenGlobal();
    }

    /**
     * CORREGIDO: Almacena de forma unificada el orden secuencial y los elementos excluidos
     */
    async function guardarOrdenGlobalPDF() {
        const stringsOrden = window.ordenGlobalElementosPDF.map(e => `${e.tipo}:${e.id}`);
        const stringsOcultos = window.ordenGlobalElementosPDF.filter(e => e.oculto).map(e => `${e.tipo}:${e.id}`);
        
        try {
            const { error } = await supabaseClient
                .from('config_orden_pdf')
                .upsert({
                    id_anio: window.evalAnioActivo.id_anio,
                    orden_elementos: stringsOrden,
                    elementos_ocultos: stringsOcultos
                }, { onConflict: 'id_anio' });

            if (error) throw error;
            alert("El orden y los criterios de visibilidad del PDF se han guardado exitosamente.");
        } catch (err) {
            console.error("Fallo guardando orden en Supabase:", err.message);
            alert("Error transaccional al salvar el ordenamiento: " + err.message);
        }
    }

    

    function moverElementoOrdenGlobal(index, direccion) {
        const nuevoIndex = index + direccion;
        if (nuevoIndex < 0 || nuevoIndex >= window.ordenGlobalElementosPDF.length) return;
        
        const temp = window.ordenGlobalElementosPDF[index];
        window.ordenGlobalElementosPDF[index] = window.ordenGlobalElementosPDF[nuevoIndex];
        window.ordenGlobalElementosPDF[nuevoIndex] = temp;
        
        renderizarPanelOrdenGlobal();
    }

    