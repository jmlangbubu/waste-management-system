(() => {
  const element = (id) => document.getElementById(id);

  function approvedApkUrl(value) {
    if (typeof value !== "string" || !value.trim()) return false;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password ||
          url.port || url.search || url.hash) return false;
      if (url.hostname === "github.com") {
        return /^\/jmlangbubu\/WMO-Mobile-Releases\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.apk$/i
          .test(url.pathname);
      }
      return url.hostname === "wastegensan.com" &&
        /^\/downloads\/[A-Za-z0-9._-]+\.apk$/i.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function setNotes(notes) {
    const list = element("releaseNotes");
    list.replaceChildren();
    for (const note of notes) {
      const item = document.createElement("li");
      item.textContent = note;
      list.appendChild(item);
    }
  }

  function showUnavailable() {
    element("downloadStatus").textContent = "Release information unavailable";
    element("downloadStatus").className = "download-status is-error";
    element("versionName").textContent = "Unavailable";
    element("downloadMessage").textContent = "Version information is temporarily unavailable.";
    element("downloadLink").hidden = true;
    element("downloadLink").removeAttribute("href");
    element("downloadPending").hidden = false;
    element("downloadPending").textContent = "Download unavailable";
    element("downloadActionNote").textContent = "Please try again later.";
    element("fileVersion").textContent = "—";
    element("fileSize").textContent = "—";
    element("packageName").textContent = "—";
    element("checksum").textContent = "—";
    setNotes(["Release notes are temporarily unavailable."]);
  }

  function showVersion(data) {
    if (!data || !Number.isSafeInteger(data.latestVersionCode) ||
        typeof data.latestVersionName !== "string" || !data.latestVersionName.trim() ||
        !Array.isArray(data.releaseNotes) ||
        !data.releaseNotes.every((note) => typeof note === "string") ||
        !data.apk || !Number.isSafeInteger(data.apk.fileSizeBytes) ||
        data.apk.fileSizeBytes <= 0 ||
        typeof data.apk.sha256 !== "string" ||
        !/^[A-Fa-f0-9]{64}$/.test(data.apk.sha256) ||
        typeof data.apk.packageName !== "string" ||
        (data.apkUrl !== null && !approvedApkUrl(data.apkUrl))) {
      throw new Error("Invalid version information");
    }

    element("versionName").textContent = data.latestVersionName;
    element("fileVersion").textContent =
      `${data.latestVersionName} (code ${data.latestVersionCode})`;
    element("fileSize").textContent =
      `${new Intl.NumberFormat("en-US").format(data.apk.fileSizeBytes)} bytes`;
    element("packageName").textContent = data.apk.packageName;
    element("checksum").textContent = data.apk.sha256.toUpperCase();
    setNotes(data.releaseNotes);

    if (data.apkUrl === null) {
      element("downloadStatus").textContent = "APK publishing in progress";
      element("downloadStatus").className = "download-status is-pending";
      element("downloadMessage").textContent =
        "The official Android download is being prepared.";
      element("downloadLink").hidden = true;
      element("downloadLink").removeAttribute("href");
      element("downloadPending").hidden = false;
      element("downloadPending").textContent = "APK Publishing in Progress";
      element("downloadActionNote").textContent =
        "The download button will become available after the public APK is verified.";
      return;
    }

    element("downloadStatus").textContent = "Official download available";
    element("downloadStatus").className = "download-status";
    element("downloadMessage").textContent =
      "Download or update the official WMO Android application.";
    element("downloadLink").href = data.apkUrl;
    element("downloadLink").hidden = false;
    element("downloadPending").hidden = true;
    element("downloadActionNote").textContent =
      "Only install the official WMO APK from the link on this page.";
  }

  async function loadVersion() {
    try {
      const response = await fetch("/api/app-version", { cache: "no-store" });
      if (!response.ok) throw new Error("Version API unavailable");
      showVersion(await response.json());
    } catch (_) {
      showUnavailable();
    }
  }

  document.addEventListener("DOMContentLoaded", loadVersion);
})();
