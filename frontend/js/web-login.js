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

function normalizeLoginRole(role) {
  return String(role || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function getDashboardByRole(role) {
  const normalizedRole = normalizeLoginRole(role);

  switch (normalizedRole) {
    case "super_admin":
    case "division_admin":
    case "personnel":
    case "supervisor":
    case "clerk_admin":
      return "admin-dashboard.html";

    default:
      return "admin-dashboard.html";
  }
}

function isAllowedWebRole(role) {
  const normalizedRole = normalizeLoginRole(role);

  return [
    "super_admin",
    "division_admin",
    "personnel",
    "supervisor",
    "clerk_admin"
  ].includes(normalizedRole);
}

function saveWebUserSession(user) {
  if (!user || typeof user !== "object") {
    throw new Error("Invalid user session payload.");
  }

  const normalizedUser = {
    ...user,
    role: normalizeLoginRole(user.role)
  };

  localStorage.setItem("webUser", JSON.stringify(normalizedUser));

  return normalizedUser;
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

      if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.textContent = "Logging in...";
      }

      showMessage("", "");

      try {
        const response = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
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

        if (!data.user || !data.user.role) {
          showMessage("Login succeeded, but account role is missing.", "error");
          return;
        }

        const normalizedRole = normalizeLoginRole(data.user.role);

        if (!isAllowedWebRole(normalizedRole)) {
          showMessage("This account role is not allowed to access the web dashboard.", "error");
          return;
        }

        const savedUser = saveWebUserSession(data.user);

        showMessage("Login successful. Redirecting...", "success");

        setTimeout(() => {
          window.location.href = getDashboardByRole(savedUser.role);
        }, 800);
      } catch (error) {
        console.error("Web login error:", error);
        showMessage("Unable to connect to the server.", "error");
      } finally {
        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.textContent = "Login";
        }
      }
    });
  } catch (error) {
    console.error("web-login init error:", error);
  }
});

function goBackToHome() {
  window.location.href = "index.html";
}

window.goBackToHome = goBackToHome;
window.getDashboardByRole = getDashboardByRole;
window.normalizeLoginRole = normalizeLoginRole;
