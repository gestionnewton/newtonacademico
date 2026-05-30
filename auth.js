// auth.js

const loginForm = document.getElementById('login-form');
const errorMsg = document.getElementById('error-msg');

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault(); // Evita que la página se recargue
        
        const dni = document.getElementById('dni').value;
        const password = document.getElementById('password').value;
        
        // Mostramos un mensaje de "Cargando..."
        errorMsg.innerText = "Verificando credenciales...";
        errorMsg.style.color = "blue";

        // Convertimos el DNI en el formato de correo que usa Supabase internamente
        const email = `${dni}@newton.edu.pe`;

        try {
            // Intentamos iniciar sesión
            const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: email,
            password: password,
            });

            if (error) throw error;

            // Si llegamos aquí, el login fue exitoso
            errorMsg.innerText = "¡Ingreso correcto! Redireccionando...";
            errorMsg.style.color = "green";

            // Guardamos el DNI en la memoria del navegador para usarlo en el Dashboard
            localStorage.setItem('user_dni', dni);

            // Redirigimos a la app principal
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 1000);

        } catch (error) {
            // Si hay un error (contraseña mal, usuario no existe, etc.)
            console.error("Error login:", error.message);
            errorMsg.style.color = "red";
            errorMsg.innerText = "DNI o contraseña incorrectos. Intente de nuevo.";
        }
    });
}

// Función para cerrar sesión (la usaremos en el botón del Sidebar)
async function logout() {
    try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) throw error;
        
        localStorage.clear();
        window.location.href = 'login.html';
    } catch (error) {
        console.error("Error al cerrar sesión:", error.message);
    }
}

// =================================================================
// SOLUCIÓN: Exponer la función globalmente para que app.js pueda usarla
// =================================================================
window.logout = logout;