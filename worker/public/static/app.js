/* Progressive enhancement only. Every screen works without this file:
   - date-mode groups are all rendered; JS just hides the irrelevant ones
   - the budget estimate is already rendered server-side on validation errors
   - delete confirmation falls back to a always-visible confirmation field
   Nothing here ever triggers a provider search. */
(function () {
  "use strict";

  /* ---------------------------------------------------- date-mode toggle */
  var modeInputs = document.querySelectorAll('input[name="date_mode"]');
  var groups = document.querySelectorAll("[data-date-group]");

  function applyMode() {
    var selected = document.querySelector('input[name="date_mode"]:checked');
    if (!selected) return;
    groups.forEach(function (group) {
      var matches = group.getAttribute("data-date-group") === selected.value;
      group.hidden = !matches;
      group.querySelectorAll("input, select").forEach(function (field) {
        // Hidden inputs must not block submission via required/validation.
        field.disabled = !matches;
      });
    });
    scheduleEstimate();
  }

  if (modeInputs.length && groups.length) {
    modeInputs.forEach(function (input) {
      input.addEventListener("change", applyMode);
    });
    applyMode();
  }

  /* --------------------------------------------------- passenger steppers */
  document.querySelectorAll("[data-stepper]").forEach(function (wrap) {
    var input = wrap.querySelector("input");
    if (!input) return;
    wrap.querySelectorAll("button[data-step]").forEach(function (button) {
      button.addEventListener("click", function () {
        var delta = parseInt(button.getAttribute("data-step"), 10) || 0;
        var min = parseInt(input.getAttribute("min") || "0", 10);
        var max = parseInt(input.getAttribute("max") || "9", 10);
        var next = (parseInt(input.value, 10) || 0) + delta;
        input.value = String(Math.min(max, Math.max(min, next)));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
  });

  /* ------------------------------------------- live call-budget estimate */
  var form = document.querySelector("form[data-estimate-url]");
  var box = document.getElementById("budget-estimate");
  var timer = null;

  function scheduleEstimate() {
    if (!form || !box) return;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(runEstimate, 350);
  }

  function runEstimate() {
    var url = form.getAttribute("data-estimate-url");
    var payload = new FormData(form);
    fetch(url, { method: "POST", body: payload, headers: { "X-Requested-With": "fetch" } })
      .then(function (response) {
        if (!response.ok) throw new Error("estimate failed");
        return response.json();
      })
      .then(function (data) {
        box.hidden = false;
        var lines = [];
        lines.push(
          "<p class='headline'>" + escapeHtml(data.headline) + "</p>",
          "<p>" + escapeHtml(data.detail) + "</p>",
          "<p class='small'>Per scan: <strong>" + data.calls_per_scan +
            "</strong> provider search(es). Available to automation now: <strong>" +
            data.remaining_safe + "</strong> of " + data.monthly_limit + ".</p>"
        );
        if (data.candidate_count) {
          lines.push(
            "<p class='small'>Date combinations in this window: <strong>" +
              data.candidate_count +
              "</strong>. A full sweep takes " + data.scans_per_full_cycle +
              " scans (" + data.calls_per_full_cycle + " searches).</p>"
          );
        }
        if (data.suggestions && data.suggestions.length) {
          lines.push("<ul>" + data.suggestions.map(function (s) {
            return "<li>" + escapeHtml(s) + "</li>";
          }).join("") + "</ul>");
        }
        if (data.date_errors && data.date_errors.length) {
          lines.push("<p class='small'><strong>Dates:</strong> " +
            escapeHtml(data.date_errors[0]) + "</p>");
        }
        box.className = "budget-box notice-" + toneFor(data.severity);
        box.innerHTML = lines.join("");
        var ack = document.getElementById("sampled-mode-row");
        if (ack) ack.hidden = data.severity === "ok";
      })
      .catch(function () {
        /* Leave the server-rendered estimate in place. */
      });
  }

  function toneFor(severity) {
    if (severity === "ok") return "success";
    if (severity === "blocked") return "danger";
    return "warning";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  if (form && box) {
    form.addEventListener("change", scheduleEstimate);
    form.addEventListener("input", function (event) {
      if (event.target && event.target.matches("input[type='number'], input[type='date']")) {
        scheduleEstimate();
      }
    });
    runEstimate();
  }

  /* --------------------------------------------------- confirm dialogues */
  document.querySelectorAll("[data-dialog-open]").forEach(function (trigger) {
    var dialog = document.getElementById(trigger.getAttribute("data-dialog-open"));
    if (!dialog || typeof dialog.showModal !== "function") return;
    trigger.addEventListener("click", function (event) {
      event.preventDefault();
      dialog.showModal();
      var first = dialog.querySelector("input, button");
      if (first) first.focus();
    });
  });
  document.querySelectorAll("[data-dialog-close]").forEach(function (button) {
    button.addEventListener("click", function () {
      var dialog = button.closest("dialog");
      if (dialog) dialog.close();
    });
  });
})();
