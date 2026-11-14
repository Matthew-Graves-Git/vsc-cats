// Bridges media/panel.js and media/terminal.js to the extension. Loaded first. Two hosts:
//  - the frameless window (window/host.cs, WebView2): window.chrome.webview. It also moves and
//    resizes the window for the page (panel.js), so `native` is true and <html> gets class "native".
//  - a VS Code webview (src/catWindow.ts): acquireVsCodeApi().
// Page -> extension: window.catYoink.send(m). Extension -> page: a normal window 'message' event
// with the message as event.data, which panel.js listens for.
(function () {
  const webview = window.chrome && window.chrome.webview;
  if (webview) {
    webview.addEventListener('message', (e) => {
      window.dispatchEvent(new MessageEvent('message', { data: e.data }));
    });
    document.documentElement.classList.add('native');
    window.catYoink = {
      native: true,
      send: (m) => webview.postMessage(m),
    };
    return;
  }
  const api = acquireVsCodeApi(); // may only be called once per page
  window.catYoink = {
    native: false,
    send: (m) => api.postMessage(m),
  };
})();
