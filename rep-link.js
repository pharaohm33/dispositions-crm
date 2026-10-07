/* Rep-specific view of a public deal page. A link ending in ?r=<id> loads
   that rep's saved page (fee + contact) from the SendMyBuyer backend and,
   while it is active: (1) adds the rep's assignment fee to the page title,
   (2) removes the sign-up / request-address block, and (3) swaps the admin
   phone/email for the rep's. The source description, ROI math, and every
   other figure stay exactly as published. If the rep deleted the page (or it
   can't be loaded) the visitor sees a "no longer active" notice instead --
   never the admin contact. All values are written with textContent. */
(function () {
  var API = "https://script.google.com/macros/s/AKfycbymgyKuPpDw_5sVhlZC_DeRBS0tM7IhW6C7f90uGwFyTdA3BvEmwSjCzyWu_Fklfq7j/exec";
  var id = new URLSearchParams(location.search).get("r");
  if (!id) return;
  id = String(id).replace(/[^\w-]/g, "").slice(0, 64);

  var hideStyle = document.createElement("style");
  hideStyle.textContent = "body{visibility:hidden !important}";
  document.head.appendChild(hideStyle);

  function showPage() { if (hideStyle.parentNode) hideStyle.parentNode.removeChild(hideStyle); }
  function inactive() {
    document.body.innerHTML = "";
    var d = document.createElement("div");
    d.textContent = "This link is no longer active.";
    d.style.cssText = "font-family:Arial,sans-serif;text-align:center;padding:80px 24px;font-size:1.1rem;color:#444;";
    document.body.appendChild(d);
    showPage();
  }

  function apply(page) {
    var fee = Number(page.fee);
    var name = String(page.name || "").replace(/[<>"']/g, "").slice(0, 60);
    var phone = String(page.phone || "").replace(/[^\d+()\-.\s]/g, "").slice(0, 25);
    var phoneDigits = phone.replace(/\D/g, "");
    var email = String(page.email || "");
    if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email)) email = "";
    if (phoneDigits.length < 7) { phone = ""; phoneDigits = ""; }

    Array.prototype.forEach.call(document.querySelectorAll('a[href*="requestAddress="]'), function (a) {
      var box = a.parentNode;
      if (box && box.parentNode === document.body) box.parentNode.removeChild(box);
    });

    var h1 = document.querySelector("h1");

    // Dead / closed deal: no fee or price to show, but keep the rep in front
    // of the buyer -- show their contact to ask for more deals, and drop the
    // link back to the SendMyBuyer marketplace.
    if (h1 && /no longer available/i.test(h1.textContent)) {
      Array.prototype.forEach.call(document.querySelectorAll('a[href*="sendmybuyer.com"]'), function (a) { a.parentNode.removeChild(a); });
      var box = document.createElement("div");
      box.style.cssText = "margin-top:24px;padding:18px;border:1px solid #ddd;border-radius:8px;font-family:Arial,sans-serif;";
      var head = document.createElement("div");
      head.style.cssText = "font-weight:bold;margin-bottom:8px;";
      head.textContent = "Looking for more deals?" + (name ? " Contact " + name + "." : "");
      box.appendChild(head);
      if (phone) {
        var pa = document.createElement("a");
        pa.href = "tel:" + (phone.charAt(0) === "+" ? "+" : "") + phoneDigits;
        pa.textContent = "Call " + phone;
        pa.style.cssText = "display:inline-block;margin:4px 8px;";
        box.appendChild(pa);
      }
      if (email) {
        var ea = document.createElement("a");
        ea.href = "mailto:" + email;
        ea.textContent = "Email " + email;
        ea.style.cssText = "display:inline-block;margin:4px 8px;";
        box.appendChild(ea);
      }
      document.body.appendChild(box);
      showPage();
      return;
    }

    if (isFinite(fee) && fee > 0) {
      var feeText = " + $" + Math.round(fee).toLocaleString("en-US") + " Assignment Fee";
      if (h1) h1.appendChild(document.createTextNode(feeText));
      document.title = document.title + feeText;
    }
    if (name && h1) {
      var by = document.createElement("div");
      by.textContent = "Presented by " + name;
      by.style.cssText = "font-size:0.95rem;margin:4px 0 10px;opacity:0.8;";
      h1.parentNode.insertBefore(by, h1.nextSibling);
    }

    var oldPhones = [], oldEmails = [];
    Array.prototype.forEach.call(document.querySelectorAll('a[href^="tel:"]'), function (a) {
      if (!phone) return;
      oldPhones.push(a.getAttribute("href").replace(/^tel:/, "").replace(/\D/g, ""));
      a.setAttribute("href", "tel:" + (phone.charAt(0) === "+" ? "+" : "") + phoneDigits);
      a.textContent = a.textContent.replace(/\+?\(?\d[\d()\-.\s]{5,}\d/, phone);
    });
    Array.prototype.forEach.call(document.querySelectorAll('a[href^="mailto:"]'), function (a) {
      if (!email) return;
      oldEmails.push(a.getAttribute("href").replace(/^mailto:/, "").split("?")[0].toLowerCase());
      a.setAttribute("href", "mailto:" + email);
      a.textContent = a.textContent.replace(/[^\s]+@[^\s]+/, email);
    });
    if (oldPhones.length || oldEmails.length) {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        var p = node.parentNode && node.parentNode.nodeName;
        if (p === "SCRIPT" || p === "STYLE") continue;
        var t = node.nodeValue, orig = t;
        if (email) oldEmails.forEach(function (e) { t = t.split(e).join(email); });
        if (phone) t = t.replace(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g, function (m) {
          return oldPhones.indexOf(m.replace(/\D/g, "")) !== -1 ? phone : m;
        });
        if (t !== orig) node.nodeValue = t;
      }
    }
    showPage();
  }

  function run() {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; inactive(); } }, 8000);
    fetch(API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "publicGetRepPage", repPageId: id }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (done) return; done = true; clearTimeout(timer); if (j && j.ok) apply(j); else inactive(); })
      .catch(function () { if (done) return; done = true; clearTimeout(timer); inactive(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();
