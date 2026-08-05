// Stand-in for the window.storage API the component expects at runtime.
// Backed by localStorage so RSVP data persists across reloads while testing locally.
window.storage = {
  async get(key) {
    const value = window.localStorage.getItem(key);
    return value === null ? null : { value };
  },
  async set(key, value) {
    window.localStorage.setItem(key, value);
    return true;
  },
};
