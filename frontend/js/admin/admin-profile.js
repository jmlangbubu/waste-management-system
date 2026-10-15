// =========================================================
// ADMIN PROFILE PICTURE - TOPBAR
// File: js/admin/admin-profile.js
//
// Purpose:
// Allows the admin user to click the topbar profile circle and
// choose a local profile picture preview.
//
// Current behavior:
// - Saves the selected image in localStorage.
// - Does not upload to database/backend yet.
// - Keeps existing admin dashboard logic untouched.
// =========================================================

(function setupAdminProfilePicture() {
  const STORAGE_KEY = "wmo_admin_topbar_profile_picture";
  const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB, safe for localStorage preview
  const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

  function showProfileImage(profileImage, profileFallback, dataUrl) {
    if (dataUrl) {
      profileImage.src = dataUrl;
      profileImage.classList.remove("hidden");
      profileFallback.style.display = "none";
      return;
    }

    profileImage.removeAttribute("src");
    profileImage.classList.add("hidden");
    profileFallback.style.display = "inline-flex";
  }

  function initProfilePictureUpload() {
    const profileBtn = document.getElementById("topbarProfileBtn");
    const profileInput = document.getElementById("topbarProfileInput");
    const profileImage = document.getElementById("topbarProfileImage");
    const profileFallback = document.getElementById("topbarProfileFallback");

    if (!profileBtn || !profileInput || !profileImage || !profileFallback) {
      return;
    }

    showProfileImage(
      profileImage,
      profileFallback,
      localStorage.getItem(STORAGE_KEY)
    );

    profileBtn.addEventListener("click", () => {
      profileInput.click();
    });

    profileInput.addEventListener("change", () => {
      const file = profileInput.files && profileInput.files[0];

      if (!file) return;

      if (!ALLOWED_TYPES.includes(file.type)) {
        alert("Please choose a JPG, PNG, or WEBP image.");
        profileInput.value = "";
        return;
      }

      if (file.size > MAX_FILE_SIZE) {
        alert("Profile picture is too large. Please choose an image under 2MB.");
        profileInput.value = "";
        return;
      }

      const reader = new FileReader();

      reader.onload = () => {
        const dataUrl = String(reader.result || "");

        if (!dataUrl) {
          profileInput.value = "";
          return;
        }

        localStorage.setItem(STORAGE_KEY, dataUrl);
        showProfileImage(profileImage, profileFallback, dataUrl);
        profileInput.value = "";
      };

      reader.onerror = () => {
        alert("Failed to load selected image.");
        profileInput.value = "";
      };

      reader.readAsDataURL(file);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initProfilePictureUpload);
  } else {
    initProfilePictureUpload();
  }
})();
