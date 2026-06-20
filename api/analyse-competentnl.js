// api/analyse-competentnl.js — Functieprofiel Decompositor CompetentNL
// CompetentNL API (https://api.competentnl.nl) + Claude voor taken- en skillsanalyse

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const CNL_BASE = 'https://api.competentnl.nl';

// ─── N-Triples parser ─────────────────────────────────────────────────────────
// Elke regel: <subject> <predicate> <object> .
// Object kan zijn: <uri> of "literal"@lang of "literal"

function parseNTriples(text) {
  const triples = [];
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  for (const line of lines) {
    // Match: subject predicate object .
    const m = line.match(/^(<[^>]+>)\s+(<[^>]+>)\s+(.*)\s+\.\s*$/);
    if (!m) continue;
    const subject = m[1].slice(1, -1); // strip < >
    const predicate = m[2].slice(1, -1);
    let object = m[3].trim();
    // Strip URI brackets
    if (object.startsWith('<') && object.endsWith('>')) {
      object = object.slice(1, -1);
    }
    // Strip literal quotes and lang tag
    else if (object.startsWith('"')) {
      object = object.replace(/^"(.*)"(@\w+)?(\^\^<[^>]+>)?$/, '$1');
    }
    triples.push({ subject, predicate, object });
  }
  return triples;
}

// Zet n-triples om naar skills-objecten
function tripleToSkills(text) {
  const triples = parseNTriples(text);

  // Groepeer per subject
  const bySubject = {};
  for (const t of triples) {
    if (!bySubject[t.subject]) bySubject[t.subject] = {};
    const key = t.predicate.split('#').pop().split('/').pop();
    if (!bySubject[t.subject][key]) bySubject[t.subject][key] = [];
    bySubject[t.subject][key].push(t.object);
  }

  const skills = [];
  for (const [uri, props] of Object.entries(bySubject)) {
    // Alleen HumanCapability (L3 vaardigheden) en ESCO skills
    const types = props['type'] || [];
    const isHumanCap = types.some(t => t.includes('HumanCapability'));
    const isESCO = uri.includes('data.europa.eu/esco/skill');

    // Voorkeurslabel NL
    const labels = props['prefLabel'] || [];
    const label = labels[0] || null;
    if (!label) continue;

    // Notatie (CompetentNL code)
    const notation = (props['notation'] || [])[0] || null;

    // ESCO match
    const escoMatches = props['closeMatchESCO'] || props['exactMatch'] || [];
    const escoUri = escoMatches.find(u => u.includes('data.europa.eu/esco')) || null;

    // Type bepalen
    let type = 'vaardigheid';
    if (isESCO) type = 'esco';
    else if (isHumanCap) type = 'humancapability';

    skills.push({
      uri,
      label,
      notation,
      type,
      esco_uri: escoUri,
      cnl_matched: true,
    });
  }

  return skills;
}

// ─── CompetentNL API aanroepen ───────────────────────────────────────────────

async function zoekCNLSkills(searchTerm, apiKey) {
  const url = `${CNL_BASE}/skills-label-08/v1?searchTerm=${encodeURIComponent(searchTerm)}&page=1&pageSize=100`;
  const res = await fetch(url, {
    headers: {
      'apikey': apiKey,
      'accept': 'application/n-triples',
    },
  });
  if (!res.ok) throw new Error(`CompetentNL API fout: ${res.status}`);
  const text = await res.text();
  if (!text || text.trim().length < 10) return [];
  return tripleToSkills(text);
}

// ─── Claude helpers ───────────────────────────────────────────────────────────

function herstelJson(json) {
  try { JSON.parse(json); return json; } catch { /**/ }
  const opens = [];
  let inStr = false, esc = false;
  for (const c of json) {
    if (esc)        { esc = false; continue; }
    if (c === '\\') { esc = true;  continue; }
    if (c === '"')  { inStr = !inStr; continue; }
    if (inStr)      continue;
    if (c === '{')       opens.push('}');
    else if (c === '[')  opens.push(']');
    else if (c === '}' || c === ']') opens.pop();
  }
  let r = json.trimEnd().replace(/,\s*$/, '').replace(/,\s*([}\]])/g, '$1');
  for (let i = opens.length - 1; i >= 0; i--) r += opens[i];
  return r;
}

async function vraagClaude(sys, prompt, apiKey, maxTokens = 16000) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system:     sys,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API fout: ${res.status} — ${await res.text()}`);
  const tekst = (await res.json()).content?.[0]?.text ?? '';
  let j = tekst;
  const blok = tekst.match(/```json\s*([\s\S]*?)```/);
  if (blok) j = blok[1].trim();
  else {
    const open = tekst.match(/```json\s*([\s\S]*)/);
    if (open) j = open[1].trim();
    else { const raw = tekst.match(/(\{[\s\S]*\}|\[[\s\S]*\])/); if (raw) j = raw[0]; }
  }
  j = herstelJson(j);
  try { return JSON.parse(j); }
  catch { throw new Error('Ongeldige JSON van Claude: ' + tekst.slice(0, 300)); }
}

// ─── Stap 1: Taken genereren ─────────────────────────────────────────────────

async function genereerTaken(functieprofiel, bedrijf, eigenTaal, apiKey) {
  return vraagClaude(
    `Je bent expert in functie-analyse en skills-based werken. Geef ALLEEN geldige JSON terug, geen markdown.`,
    `Analyseer dit functieprofiel grondig. Haal ALLE taken op:
1. Taken die expliciet in het profiel staan
2. Taken die standaard bij dit beroep horen (sectorkennis)
3. Taken die bij de context van het bedrijf horen

FUNCTIEPROFIEL: ${functieprofiel}
${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}
${eigenTaal ? `BEDRIJFSEIGEN TERMEN: ${eigenTaal}` : ''}

JSON (direct, geen markdown):
{"functietitel":"string","samenvatting":"max 2 zinnen","vergelijkbare_titels":["string"],"taken":[{"id":"T01","taak":"concrete taakomschrijving","bron":"profiel|beroep|bedrijf","frequentie":"dagelijks|wekelijks|maandelijks","belang":"hoog|middel|laag","geselecteerd":true}]}

Genereer 15-30 taken afhankelijk van de complexiteit van de functie. Wees volledig en concreet.`,
    apiKey
  );
}

// ─── Stap 2: Skills koppelen via CompetentNL ─────────────────────────────────

async function koppelSkills(functietitel, taken, functieprofiel, bedrijf, eigenTaal, anthropicKey, cnlKey) {

  // Verzamel zoektermen: functietitel + kernwoorden uit taken
  const zoektermen = new Set();
  zoektermen.add(functietitel);

  // Extraheer kernwoorden uit taken via Claude
  const kernwoorden = await vraagClaude(
    `Je bent expert in Nederlandse arbeidsmarktterminologie. Geef ALLEEN geldige JSON terug.`,
    `Extraheer de belangrijkste Nederlandse vaardigheidstermen uit deze functietitel en taken.
Geef maximaal 15 zoektermen terug die aansluiten bij de CompetentNL/ESCO-taxonomie.
Gebruik enkelvoud, losse woorden of korte woordgroepen.

FUNCTIETITEL: ${functietitel}
TAKEN: ${taken.map(t => t.taak).join('; ')}

JSON: {"termen": ["term1", "term2", ...]}`,
    anthropicKey,
    2000
  );

  (kernwoorden.termen || []).forEach(t => zoektermen.add(t));

  // Zoek skills per term (sequentieel om rate limiting te voorkomen)
  const alleSkills = new Map();
  for (const term of zoektermen) {
    try {
      const gevonden = await zoekCNLSkills(term, cnlKey);
      gevonden.forEach(s => {
        if (!alleSkills.has(s.uri)) alleSkills.set(s.uri, s);
      });
      // Kleine pauze tussen requests
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.log(`CNL zoek fout voor "${term}":`, e.message);
    }
  }

  const skillsLijst = [...alleSkills.values()];
  console.log(`CompetentNL gevonden: ${skillsLijst.length} unieke skills`);

  // Bouw keuzelijst voor Claude
  const skillsTekst = skillsLijst
    .map(s => `${s.label}|${s.notation || s.uri.split('/').pop()}|${s.type}`)
    .join('\n');

  const takenTekst = taken.map(t => `- ${t.id}: ${t.taak}`).join('\n');

  const eigenTermenLijst = eigenTaal
    ? eigenTaal.split(/[,\n]/).map(t => t.trim()).filter(Boolean)
    : [];

  const resultaat = await vraagClaude(
    `Je bent CompetentNL-expert en skills-analist. Geef ALLEEN geldige JSON terug, geen markdown.
KRITIEKE REGEL: gebruik skills UITSLUITEND uit de meegestuurde CompetentNL-lijst.
Gebruik het exacte label en de exacte code. Verzin NOOIT zelf skills.
MAX 3 vaardigheden en 2 competenties per taak.`,
    `Koppel CompetentNL-skills aan taken voor: ${functietitel}

TAKEN:
${takenTekst}
${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}
${eigenTaal ? `BEDRIJFSEIGEN TERMEN: ${eigenTaal}` : ''}

BESCHIKBARE COMPETENTNL SKILLS (label|code|type):
${skillsTekst || '(geen gevonden — gebruik dan alleen bedrijfseigen termen)'}

JSON (direct, geen markdown):
{
  "taken": [{
    "id": "T01",
    "vaardigheden": [{
      "skill": "exacte label uit de lijst",
      "cnl_code": "exacte code uit de lijst",
      "niveau": "Basis|Gevorderd|Expert",
      "bron": "profiel|beroep|bedrijf",
      "toelichting": "waarom relevant voor deze taak"
    }],
    "competenties": [{
      "competentie": "exacte label uit de lijst",
      "cnl_code": "exacte code uit de lijst",
      "niveau": "Basis|Gevorderd|Expert",
      "bron": "profiel|beroep|bedrijf",
      "toelichting": "waarom relevant voor deze taak"
    }]
  }]
}`,
    anthropicKey
  );

  // Bouw lookup
  const lookup = new Map(skillsLijst.map(s => [s.label, s]));
  const lookupByCode = new Map(
    skillsLijst
      .filter(s => s.notation)
      .map(s => [s.notation, s])
  );

  const enrichSkill = (item, labelKey) => {
    const label = item[labelKey];
    const code = item.cnl_code;
    const gevonden = lookup.get(label) || lookupByCode.get(code);
    return {
      ...item,
      cnl_label: label,
      cnl_code: gevonden?.notation || code || null,
      cnl_uri: gevonden?.uri || null,
      cnl_esco_uri: gevonden?.esco_uri || null,
      cnl_type: gevonden?.type || null,
      cnl_matched: !!gevonden,
    };
  };

  // Voeg bedrijfseigen termen toe als losse competenties
  const eigenSkills = eigenTermenLijst.map(term => ({
    competentie: term,
    cnl_code: null,
    niveau: 'Gevorderd',
    bron: 'bedrijf',
    toelichting: 'Bedrijfseigen term',
    cnl_label: term,
    cnl_uri: null,
    cnl_esco_uri: null,
    cnl_type: 'eigen',
    cnl_matched: false,
    eigen: true,
  }));

  return {
    ...resultaat,
    taken: (resultaat.taken ?? []).map(taak => ({
      ...taak,
      vaardigheden: (taak.vaardigheden ?? []).map(s => enrichSkill(s, 'skill')),
      competenties: [
        ...(taak.competenties ?? []).map(s => enrichSkill(s, 'competentie')),
        ...eigenSkills,
      ],
    })),
  };
}

// ─── Vercel handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Alleen POST' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const cnlKey = process.env.CNL_API_KEY;

  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet ingesteld' });
  if (!cnlKey) return res.status(500).json({ error: 'CNL_API_KEY niet ingesteld' });

  try {
    const { stap, functieprofiel, functietitel, taken, bedrijf, eigenTaal } = req.body ?? {};

    if (stap === 1) {
      if (!functieprofiel) return res.status(400).json({ error: 'functieprofiel verplicht' });
      return res.status(200).json(await genereerTaken(functieprofiel, bedrijf, eigenTaal, anthropicKey));
    }

    if (stap === 2) {
      if (!taken?.length) return res.status(400).json({ error: 'taken verplicht' });
      return res.status(200).json(
        await koppelSkills(functietitel, taken, functieprofiel, bedrijf, eigenTaal, anthropicKey, cnlKey)
      );
    }

    return res.status(400).json({ error: `Onbekende stap: ${stap}` });
  } catch (e) {
    console.error('Fout:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
