if (!window.APP_CONFIG || !window.APP_CONFIG.API_BASE_URL) {
  throw new Error("API config is missing");
}

const API_URL = `${window.APP_CONFIG.API_BASE_URL}/web-auth/login`;

const loginForm = document.getElementById("loginForm");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const messageBox = document.getElementById("messageBox");

function showMessage(message, type) {
  if (!messageBox) return;
  messageBox.textContent = message;
  messageBox.className = `message-box ${type}`;
}

function getDashboardByRole(role) {
  switch (role) {
    case "super_admin":
    case "division_admin":
    case "personnel":
    default:
      return "admin-dashboard.html";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    const savedUserRaw = localStorage.getItem("webUser");
    const savedUser = savedUserRaw ? JSON.parse(savedUserRaw) : null;

    if (savedUser && savedUser.role) {
      window.location.href = getDashboardByRole(savedUser.role);
      return;
    }

    if (!loginForm) {
      console.error("loginForm not found in DOM.");
      return;
    }

    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const username = usernameInput?.value.trim() || "";
      const password = passwordInput?.value.trim() || "";

      if (!username || !password) {
        showMessage("Username and password are required.", "error");
        return;
      }

      loginBtn.disabled = true;
      loginBtn.textContent = "Logging in...";
      showMessage("", "");

      try {
        const response = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify({ username, password })
        });

        const rawText = await response.text();
        let data = {};

        try {
          data = rawText ? JSON.parse(rawText) : {};
        } catch (parseError) {
          console.error("Login raw response:", rawText);
          throw new Error("Login API did not return valid JSON.");
        }

        if (!response.ok || !data.success) {
          showMessage(data.message || "Login failed.", "error");
          return;
        }

        localStorage.setItem("webUser", JSON.stringify(data.user));
        showMessage("Login successful. Redirecting...", "success");

        setTimeout(() => {
          window.location.href = getDashboardByRole(data.user.role);
        }, 800);
      } catch (error) {
        console.error("Web login error:", error);
        showMessage("Unable to connect to the server.", "error");
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = "Login";
      }
    });
  } catch (error) {
    console.error("web-login init error:", error);
  }
});

function goBackToHome() {
  window.location.href = "index.html";
}