exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { email, url, score } = body;
  if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: "Email manquant" }) };

  const BREVO_KEY = process.env.BREVO_KEY;
  if (!BREVO_KEY) {
    console.error("[brevo] ❌ BREVO_KEY manquante — variable d'env non injectée");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "BREVO_KEY manquante" }) };
  }

  try {
    const payload = {
      email,
      listIds: [7], // ⚠️ Vérifier que cet ID correspond bien à ta liste dans Brevo
      attributes: { SOURCE: "diagnostic_virgule", SITE_ANALYSE: url, SCORE: score },
      updateEnabled: true,
    };
    console.log("[brevo] → Envoi contact", { email, url, score });

    const resp = await fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": BREVO_KEY },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error(`[brevo] ❌ Erreur Brevo ${resp.status}:`, JSON.stringify(data));
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: "Erreur Brevo", details: data }) };
    }

    console.log(`[brevo] ✅ Contact ajouté (${resp.status})`, JSON.stringify(data));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (e) {
    console.error("[brevo] ❌ Exception réseau:", e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
