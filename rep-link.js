/* Rep-specific view of a public deal page. Reads ?fee=&rn=&rp=&re= from the
   link a rep copied from SendMyBuyer and, only when present, (1) adds the
   rep's assignment fee to the page title, (2) removes the sign-up / request-address block, and (3) swaps the admin phone/email
   for the rep's. The source description, ROI math, and every other figure are
   left exactly as published. All values are sanitized and written with
   textContent -- nothing from the URL is ever inserted as HTML. */
(function () {
  var q = new URLSearchParams(location.search);
  var fee = Number(String(q.get("fee") || "").replace(/[^\d.]/g, ""));
  var name = String(q.get("rn") || "").replace(/[<>"']/g, "").trim().slice(0, 60);
  var phone = String(q.get("rp") || "").replace(/[^\d+()\-.\s]/g, "").trim().slice(0, 25);
  var phoneDigits = phone.replace(/\D/g, "");
  var email = String(q.get("re") || "").trim().slice(0, 80);
  if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email)) email = "";
  if (phoneDigits.length < 7) { phone = ""; phoneDigits = ""; }
  var hasFee = isFinite(fee) && fee > 0;
  if (!hasFee && !phone && !email && !name) return;

  function run() {
    // A rep link is not a path into the SendMyBuyer marketplace: drop the
    // sign-up / log-in / request-address block so buyers coming through it
    // never register and browse the original prices.
    Array.prototype.forEach.call(document.querySelectorAll('a[href*="requestAddress="]'), function (a) {
      var box = a.parentNode;
      if (box && box.parentNode === document.body) box.parentNode.removeChild(box);
    });
    if (hasFee) {
      var feeText = " + $" + Math.round(fee).toLocaleString("en-US") + " Assignment Fee";
      var h1 = document.querySelector("h1");
      if (h1) h1.appendChild(document.createTextNode(feeText));
      document.title = document.title + feeText;
    }
    if (name && h1Exists()) {
      var by = document.createElement("div");
      by.textContent = "Presented by " + name;
      by.style.cssText = "font-size:0.95rem;margin:4px 0 10px;opacity:0.8;";
      var h1b = document.querySelector("h1");
      h1b.parentNode.insertBefore(by, h1b.nextSibling);
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
    if (!oldPhones.length && !oldEmails.length) return;
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
  function h1Exists() { return !!document.querySelector("h1"); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();
