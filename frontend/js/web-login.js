if (!window.APP_CONFIG || !window.APP_CONFIG.API_BASE_URL) {
  throw new Error("API config is missing");
}

const API_URL = `${window.APP_CONFIG.API_BASE_URL}/web-auth/login`;

const loginForm = document.getElementById("loginForm");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const messageBox = document.getElementById("messageBox");

function getLoginResponseContentType(response) {
  return String(response?.headers?.get?.("content-type") || "")
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

function createLoginResponseError(code, response, contentType) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = Number.isInteger(response?.status) ? response.status : null;
  error.contentType = contentType || "";
  return error;
}

async function parseLoginApiResponse(response) {
  const contentType = getLoginResponseContentType(response);
  let rawText = "";

  try {
    rawText = await response.text();
  } catch (error) {
    throw createLoginResponseError(
      "WEB_LOGIN_NETWORK_ERROR",
      response,
      contentType
    );
  }

  if (!contentType.includes("application/json")) {
    throw createLoginResponseError(
      "WEB_LOGIN_INVALID_RESPONSE",
      response,
      contentType
    );
  }

  try {
    const data = rawText ? JSON.parse(rawText) : null;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new TypeError("Login response must be a JSON object.");
    }
    return { data, contentType };
  } catch (error) {
    throw createLoginResponseError(
      "WEB_LOGIN_INVALID_RESPONSE",
      response,
      contentType
    );
  }
}

function getSafeLoginErrorCode(data, status) {
  const serverCode = typeof data?.code === "string" ? data.code.trim() : "";
  if (/^[A-Z0-9_]{1,80}$/.test(serverCode)) return serverCode;
  return Number.isInteger(status) ? `HTTP_${status}` : "WEB_LOGIN_FAILED";
}

function getLoginFailureMessage(status, data) {
  const serverMessage = typeof data?.message === "string"
    ? data.message.trim()
    : "";

  if (status === 401) {
    return serverMessage || "Invalid username or password.";
  }
  if (status === 403) {
    return serverMessage || "This account is not allowed to sign in.";
  }
  if (status === 503) {
    return "Web Admin authentication is temporarily unavailable. Please try again.";
  }
  if (status >= 500) {
    return "The server could not complete the login. Please try again.";
  }
  return serverMessage || "Login failed.";
}

function logLoginDiagnostic({ status = null, contentType = "", code }) {
  console.error("[WebAuth] Login request failed.", {
    endpoint: API_URL,
    status,
    contentType,
    code
  });
}

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

async function restoreServerSession() {
  try {
    const response = await fetch(
      `${window.APP_CONFIG.API_BASE_URL}/web-auth/session`,
      {
        headers: { Accept: "application/json" },
        credentials: "include"
      }
    );
    if (!response.ok) {
      localStorage.removeItem("webUser");
      return false;
    }
    const data = await response.json();
    if (!data.success || !data.user || !isAllowedWebRole(data.user.role)) {
      localStorage.removeItem("webUser");
      return false;
    }
    const user = saveWebUserSession(data.user);
    window.location.replace(getDashboardByRole(user.role));
    return true;
  } catch (error) {
    localStorage.removeItem("webUser");
    return false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    if (await restoreServerSession()) return;

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
        let response;
        try {
          response = await fetch(API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json"
            },
            body: JSON.stringify({ username, password }),
            credentials: "include"
          });
        } catch (error) {
          logLoginDiagnostic({ code: "WEB_LOGIN_NETWORK_ERROR" });
          showMessage(
            "Unable to reach the server. Check your connection and try again.",
            "error"
          );
          return;
        }

        let parsedResponse;
        try {
          parsedResponse = await parseLoginApiResponse(response);
        } catch (error) {
          const code = error?.code === "WEB_LOGIN_NETWORK_ERROR"
            ? "WEB_LOGIN_NETWORK_ERROR"
            : "WEB_LOGIN_INVALID_RESPONSE";
          logLoginDiagnostic({
            status: error?.httpStatus ?? response.status,
            contentType: error?.contentType || getLoginResponseContentType(response),
            code
          });
          showMessage(
            code === "WEB_LOGIN_NETWORK_ERROR"
              ? "Unable to reach the server. Check your connection and try again."
              : "The login server returned an invalid response. Please try again.",
            "error"
          );
          return;
        }

        const { data, contentType } = parsedResponse;

        if (!response.ok || !data.success) {
          logLoginDiagnostic({
            status: response.status,
            contentType,
            code: getSafeLoginErrorCode(data, response.status)
          });
          showMessage(getLoginFailureMessage(response.status, data), "error");
          return;
        }

        if (!data.user || !data.user.role) {
          logLoginDiagnostic({
            status: response.status,
            contentType,
            code: "WEB_LOGIN_INVALID_USER_PAYLOAD"
          });
          showMessage("Login succeeded, but account role is missing.", "error");
          return;
        }

        const normalizedRole = normalizeLoginRole(data.user.role);

        if (!isAllowedWebRole(normalizedRole)) {
          logLoginDiagnostic({
            status: response.status,
            contentType,
            code: "WEB_LOGIN_ROLE_FORBIDDEN"
          });
          showMessage("This account role is not allowed to access the web dashboard.", "error");
          return;
        }

        let savedUser;
        try {
          savedUser = saveWebUserSession(data.user);
        } catch (error) {
          logLoginDiagnostic({
            status: response.status,
            contentType,
            code: "WEB_LOGIN_BROWSER_SESSION_ERROR"
          });
          showMessage(
            "Login succeeded, but this browser could not save the session. Please try again.",
            "error"
          );
          return;
        }

        showMessage("Login successful. Redirecting...", "success");

        setTimeout(() => {
          window.location.href = getDashboardByRole(savedUser.role);
        }, 800);
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
