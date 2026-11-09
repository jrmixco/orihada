// Fills download links, version, sizes and fingerprints from latest.json (written by scripts/site.mjs).
(async () => {
  let info;
  try { info = await (await fetch("latest.json", { cache: "no-store" })).json(); } catch { return; }
  const mb = (n) => `${Math.round(n / 1048576)} MB`;
  document.querySelectorAll("[data-ver]").forEach((el) => { el.textContent = `Version ${info.version}`; });
  for (const [key, f] of Object.entries(info.files || {})) {
    document.querySelectorAll(`[data-dl="${key}"]`).forEach((a) => { a.href = f.url; a.setAttribute("download", f.name); });
    document.querySelectorAll(`[data-size="${key}"]`).forEach((el) => { el.textContent = mb(f.size); });
  }
  const dl = document.getElementById("hashes");
  dl.replaceChildren(...Object.values(info.files || {}).flatMap((f) => {
    const dt = document.createElement("dt"); dt.textContent = f.name;
    const dd = document.createElement("dd"); dd.textContent = f.sha256;
    return [dt, dd];
  }));
})();
