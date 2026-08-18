/** The loading state: what a visitor sees between opening the panel (or
 *  refreshing with it open) and the first history frame. */
async page => {
  const B = "http://localhost:8124";
  const ctl = (d) => page.request.post(B + "/__ctl", { data: d });
  const sr = (fn) => page.evaluate(fn);
  const R = []; const check = (n, p, d) => R.push({ name: n, pass: !!p, detail: d });
  await ctl({ set: { history: [], received: [], hasMore: false, olderPages: [], holdHistoryMs: 4000, handshakeError: null,
    config: { theme: { primaryColor: "#10b981", launcherColor: "#10b981" }, headerTitle: "Loadless Support",
      headerSubtitle: "Typically replies in a few minutes", welcomeMessage: "Hi! How can we help?" } } });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(B + "/host.html");
  await page.evaluate(() => localStorage.clear());
  await page.goto(B + "/host.html");
  await page.waitForTimeout(700);
  await sr(() => document.getElementById("ccp-webchat-root").shadowRoot.querySelector(".launch").click());
  await page.waitForTimeout(500);

  const loading = await sr(() => {
    const s = document.getElementById("ccp-webchat-root").shadowRoot;
    const sk = s.querySelector(".skel");
    const b = s.querySelector(".body");
    const first = sk && sk.querySelector(".skb");
    return { present: !!sk, rows: sk ? sk.querySelectorAll(".skrow").length : 0,
      avatars: sk ? sk.querySelectorAll(".skav").length : 0,
      busy: b.getAttribute("aria-busy"),
      bg: first ? getComputedStyle(first).backgroundColor : null,
      bubbleWidth: first ? Math.round(first.getBoundingClientRect().width) : 0,
      bubbleHeight: first ? Math.round(first.getBoundingClientRect().height) : 0,
      bodyEmpty: b.textContent.trim() === "",
      animated: first ? getComputedStyle(first).animationName : null };
  });
  check("a skeleton fills the panel while it loads", loading.present && loading.rows === 3, loading);
  check("it is shaped like a conversation (avatars on inbound rows)", loading.avatars === 2, loading);
  check("it is announced to screen readers", loading.busy === "true", loading);
  check("the placeholder is actually painted (not invisible)", loading.bg && loading.bg !== "rgba(0, 0, 0, 0)", loading.bg);
  // A coloured element with zero width is still invisible — check the geometry.
  check("placeholder bubbles have real size", loading.bubbleWidth > 100 && loading.bubbleHeight > 20, loading);
  check("it shimmers", loading.animated === "skw", loading.animated);

  // Once history lands the skeleton must be gone, with no leftover artefacts.
  await page.waitForTimeout(4200);
  const loaded = await sr(() => {
    const s = document.getElementById("ccp-webchat-root").shadowRoot;
    const b = s.querySelector(".body");
    return { skel: !!s.querySelector(".skel"), busy: b.getAttribute("aria-busy"),
      welcome: s.querySelector(".mr.in .bubble")?.textContent.trim(),
      composer: s.querySelector(".composer").style.display !== "none" };
  });
  check("skeleton is removed once content arrives", !loaded.skel && !loaded.busy, loaded);
  check("real content replaces it", loaded.welcome === "Hi! How can we help?" && loaded.composer, loaded);

  // A REFRESH with the panel open is the case the user reported.
  await ctl({ set: { holdHistoryMs: 4000 } });
  await page.goto(B + "/host.html");
  await page.waitForTimeout(900);
  const afterRefresh = await sr(() => {
    const s = document.getElementById("ccp-webchat-root").shadowRoot;
    return { open: s.querySelector(".panel").classList.contains("open"),
      skel: !!s.querySelector(".skel"),
      bodyBlank: s.querySelector(".body").textContent.trim() === "" && !s.querySelector(".skel") };
  });
  check("refresh with the panel open shows the skeleton, not white space", afterRefresh.open && afterRefresh.skel && !afterRefresh.bodyBlank, afterRefresh);
  return JSON.stringify(R, null, 2);
}
