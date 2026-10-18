/* Headline -> Market UI. Plain JS. All model output is inserted via textContent. */
(function () {
  "use strict";

  var MARKET_FIELDS = [
    { key: "question", label: "Question", multiline: true },
    { key: "closeTime", label: "Close time (ISO 8601 with offset)", multiline: false },
    { key: "resolutionSource", label: "Resolution source", multiline: false },
    { key: "yesCriteria", label: "YES criteria", multiline: true },
    { key: "noCriteria", label: "NO criteria", multiline: true },
    { key: "edgeCases", label: "Edge cases", multiline: true }
  ];

  /** Create an element; text is always set with textContent (XSS-safe). */
  function el(tag, options, children) {
    var node = document.createElement(tag);
    options = options || {};
    if (options.text !== undefined && options.text !== null) {
      node.textContent = String(options.text);
    }
    if (options.className) node.className = options.className;
    if (options.type) node.setAttribute("type", options.type);
    if (options.placeholder) node.setAttribute("placeholder", options.placeholder);
    if (options.value !== undefined) node.value = String(options.value);
    if (options.dataset) {
      Object.keys(options.dataset).forEach(function (k) {
        node.setAttribute("data-" + k, options.dataset[k]);
      });
    }
    if (options.onClick) node.addEventListener("click", options.onClick);
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function badge(text, kind) {
    return el("span", { className: "badge " + kind, text: text });
  }

  function statusBadge(status) {
    return badge(status, status);
  }

  function api(path, method, body) {
    var init = { method: method || "GET", headers: {} };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () {
        return {};
      }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || "Request failed");
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return { ist: "invalid", utc: "invalid" };
    return {
      utc: d.toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC",
      ist: d.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST"
    };
  }

  var $result = document.getElementById("result");
  var $empty = document.getElementById("result-empty");
  var $list = document.getElementById("draft-list");
  var $headline = document.getElementById("headline");
  var $snippet = document.getElementById("snippet");
  var $draftBtn = document.getElementById("draft-btn");
  var $inputError = document.getElementById("input-error");

  function showEmptyState(message) {
    $empty.textContent = message;
    $empty.classList.remove("hidden");
    $result.replaceChildren();
  }

  function setBusy(busy) {
    $draftBtn.disabled = busy;
    $draftBtn.textContent = busy ? "Drafting…" : "Draft market";
  }

  function clearResult() {
    $empty.classList.add("hidden");
    $result.replaceChildren();
  }

  /* ---------- rendering ---------- */

  function renderMarket(record, container) {
    var payload = record.payload || {};
    var editable = record.status === "draft";
    var form = el("div", { className: "market-form" });

    var head = el("div", { className: "row" }, [
      statusBadge(record.status),
      badge(record.kind, record.kind)
    ]);
    if (record.status === "published") {
      head.appendChild(el("span", { className: "published-note", text: "Published — not editable" }));
    }
    form.appendChild(head);

    MARKET_FIELDS.forEach(function (field) {
      var input = field.multiline
        ? el("textarea", { value: payload[field.key] || "" })
        : el("input", { type: "text", value: payload[field.key] || "" });
      input.disabled = !editable;
      input.setAttribute("data-field", field.key);
      var wrap = el("div", { className: editable ? "" : "field-readonly" }, [
        el("label", { text: field.label }),
        input
      ]);
      if (field.key === "closeTime") {
        var f = formatTime(payload[field.key]);
        wrap.appendChild(el("div", { className: "time-note", text: "IST: " + f.ist }));
        wrap.appendChild(el("div", { className: "time-note", text: "UTC: " + f.utc }));
      }
      form.appendChild(wrap);
    });

    if (editable) {
      var saveBtn = el("button", { text: "Save edit" });
      var approveBtn = el("button", { className: "ok", text: "Approve" });
      var discardBtn = el("button", { className: "danger", text: "Discard" });

      saveBtn.addEventListener("click", function () {
        var body = collectFields(form);
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        api("/api/drafts/" + record.id, "PUT", body)
          .then(function (data) {
            renderResult(data.draft);
            refreshList();
          })
          .catch(function (err) {
            alert("Save failed: " + err.message);
          })
          .then(function () {
            saveBtn.disabled = false;
            saveBtn.textContent = "Save edit";
          });
      });

      approveBtn.addEventListener("click", function () {
        approveBtn.disabled = true;
        approveBtn.textContent = "Approving…";
        api("/api/drafts/" + record.id + "/approve", "POST")
          .then(function (data) {
            renderResult(data.draft);
            refreshList();
          })
          .catch(function (err) {
            alert("Approve failed: " + err.message);
            approveBtn.disabled = false;
            approveBtn.textContent = "Approve";
          });
      });

      discardBtn.addEventListener("click", function () {
        api("/api/drafts/" + record.id + "/discard", "POST")
          .then(function (data) {
            renderResult(data.draft);
            refreshList();
          })
          .catch(function (err) {
            alert("Discard failed: " + err.message);
          });
      });

      form.appendChild(el("div", { className: "row" }, [approveBtn, saveBtn, discardBtn]));
    }

    container.appendChild(form);
  }

  function collectFields(container) {
    var body = {};
    var inputs = container.querySelectorAll("[data-field]");
    Array.prototype.forEach.call(inputs, function (input) {
      body[input.getAttribute("data-field")] = input.value;
    });
    return body;
  }

  function renderUnresolvable(record, container) {
    var payload = record.payload || {};
    var box = el("div", { className: "message-box unresolvable" }, [
      el("strong", { text: "This headline cannot become a fair market" }),
      el("p", { text: "Reason: " + (payload.reason || "unknown") }),
      el("p", { text: "Category: " + (payload.category || "other") })
    ]);
    container.appendChild(box);
    container.appendChild(actionRow(record, false));
  }

  function renderError(record, container) {
    var payload = record.payload || {};
    var reason = record.reason || payload.reason || "";
    var children = [
      el("strong", { text: record.message || "Generation failed" })
    ];
    if (reason) {
      children.push(el("p", { className: "muted", text: "Reason: " + reason }));
    }
    children.push(
      el("p", { className: "muted", text: "Code: " + (payload.code || "unknown") })
    );
    var box = el("div", { className: "message-box error" }, children);
    container.appendChild(box);
    container.appendChild(actionRow(record, true));
  }

  function actionRow(record, includeRetry) {
    var row = el("div", { className: "row" });
    if (includeRetry) {
      var retry = el("button", { text: "Retry" });
      retry.addEventListener("click", function () {
        retry.disabled = true;
        retry.textContent = "Retrying…";
        api("/api/drafts/" + record.id + "/retry", "POST")
          .then(function (data) {
            renderResult(data.draft);
            refreshList();
          })
          .catch(function (err) {
            alert("Retry failed: " + err.message);
            retry.disabled = false;
            retry.textContent = "Retry";
          });
      });
      row.appendChild(retry);
    }
    var manual = el("button", { text: "Draft manually" });
    manual.addEventListener("click", function () {
      renderManualForm(record.headline);
    });
    row.appendChild(manual);
    return row;
  }

  function renderManualForm(headline) {
    clearResult();
    var form = el("div");
    form.appendChild(el("h3", { text: "Draft manually" }));
    form.appendChild(el("label", { text: "Headline" }));
    var headlineInput = el("input", { type: "text", value: headline || "" });
    form.appendChild(headlineInput);

    MARKET_FIELDS.forEach(function (field) {
      var input = field.multiline
        ? el("textarea", { placeholder: field.label })
        : el("input", { type: "text", placeholder: field.label });
      input.setAttribute("data-field", field.key);
      form.appendChild(el("label", { text: field.label }));
      form.appendChild(input);
    });

    var submit = el("button", { className: "primary", text: "Create draft" });
    submit.addEventListener("click", function () {
      var body = collectFields(form);
      body.headline = headlineInput.value;
      submit.disabled = true;
      submit.textContent = "Creating…";
      api("/api/drafts/manual", "POST", body)
        .then(function (data) {
          renderResult(data.draft);
          refreshList();
        })
        .catch(function (err) {
          alert("Create failed: " + err.message);
          submit.disabled = false;
          submit.textContent = "Create draft";
        });
    });
    form.appendChild(el("div", { className: "row" }, [submit]));
    $result.appendChild(form);
  }

  function renderResult(record) {
    clearResult();
    if (!record) {
      showEmptyState("Nothing drafted yet.");
      return;
    }
    if (record.kind === "market") {
      renderMarket(record, $result);
    } else if (record.kind === "unresolvable") {
      renderUnresolvable(record, $result);
    } else {
      renderError(record, $result);
    }
  }

  function refreshList() {
    api("/api/drafts", "GET").then(function (data) {
      var drafts = data.drafts || [];
      $list.replaceChildren();
      if (drafts.length === 0) {
        $list.appendChild(el("p", { className: "muted", text: "No drafts yet." }));
        return;
      }
      drafts.forEach(function (record) {
        var title = el("span", { className: "title", text: record.headline });
        var badges = el("span", {}, [statusBadge(record.status), document.createTextNode(" "), badge(record.kind, record.kind)]);
        var item = el("button", { className: "draft-item", onClick: function () { renderResult(record); } }, [title, badges]);
        $list.appendChild(item);
      });
    });
  }

  /* ---------- actions ---------- */

  $draftBtn.addEventListener("click", function () {
    var headline = $headline.value.trim();
    $inputError.textContent = "";
    if (headline.length < 5 || headline.length > 300) {
      $inputError.textContent = "Headline must be 5 to 300 characters.";
      return;
    }
    var snippet = $snippet.value.trim();
    var body = { headline: headline };
    if (snippet.length > 0) body.snippet = snippet;

    setBusy(true);
    api("/api/drafts", "POST", body)
      .then(function (data) {
        renderResult(data.draft);
        refreshList();
      })
      .catch(function (err) {
        $inputError.textContent = err.message;
      })
      .then(function () {
        setBusy(false);
      });
  });

  refreshList();
})();
