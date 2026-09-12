// Runs in the upstream iframe's isolated world to observe its SPA navigation.
const publish = () => {
  if (window.parent === window) return;
  window.parent.postMessage(
    { type: "opencode-chrome:location", pathname: location.pathname },
    `chrome-extension://${chrome.runtime.id}`,
  );
};

window.navigation.addEventListener("currententrychange", publish);

window.addEventListener("pageshow", publish);

window.addEventListener("message", (event) => {
  if (
    event.source === window.parent &&
    event.origin === `chrome-extension://${chrome.runtime.id}` &&
    event.data === "opencode-chrome:request-location"
  )
    publish();
});

publish();
