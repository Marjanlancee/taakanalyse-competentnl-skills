// api/analyse-competentnl.js — Functieprofiel Decompositor CompetentNL v3
// Strategie: zoek beroep → gebruik volledige URI → haal skills op via skills endpoints

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const CNL_BASE = 'https://api.competentnl.nl';

// ─── N-Triples parser ─────────────────────────────────────────────────────────

function parseNTriples(text) {
  const triples = [];
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  for (const line of lines) {
    // Match subject predicate object .
    const m = line.match(/^(<[^>]+>|_:\S+)\s+(<[^>]+>)\s+(.*?)\s*\.\s*$/);
    if (!m) continue;
    const subject = m[1].startsWith('<') ? m[1].slice(1, -1) : m[1];
    const predicate = m[2].slice(1, -1);
    let object = m[3].trim();
    if (object.startsWith('<') && object.endsWith('>')) {
      object = object.slice(1, -1);
    } else if (object.startsWith('"')) {
      object = object.replace(/^"(.*?)"(@[\w-]+)?(\^\^<[^>]+>)?$/, '$1');
    }
    triples.push({ subject, predicate, object });
  }
  return triples;
}

function groupBySubject(triples) {
  const map = {};
  for (const t of triples) {
    if (!map[t.subject]) map[t.subject] = {};
    const key = t.predicate.split('#').pop().split('/').pop();
    if (!map[t.subject][key]) map[t.subject][key] = [];
    if (!map[t.subject][key].includes(t.object)) map[t.subject][key].push(t.object);
  }
  return map;
}

// ─── CompetentNL API helpers ──────────────────────────────────────────────────

async function cnlGet(endpoint, cnlKey) {
  const url = `${CNL_BASE}${endpoint}`;
  console.log('CNL GET:', url);
  const res = await fetch(url, {
    headers: { 'apikey': cnlKey, 'accept': 'application/n-triples' }
  });
  if (!res.ok) {
    const body = await res.text();
    console.log(`CNL fout ${res.status}:`, body.slice(0, 200));
    return {};
  }
  const text = await res.text();
  console.log(`CNL response length: ${text.length}`);
  if (!text || text.trim().length < 10) return {};
  return groupBySubject(parseNTriples(text));
}

// Zoek beroepen op label
async function zoekBeroepen(searchTerm, cnlKey) {
  const data = await cnlGet(
    `/occupations-label-01/v1?searchTerm=${encodeURIComponent(searchTerm)}&page=1&pageSize=20`,
    cnlKey
  );
  const beroepen = [];
  for (const [uri, props] of Object.entries(data)) {
    if (!uri.includes('/occupation/') && !uri.includes('/uwv/')) continue;
    const labels = props['prefLabel'] || props['literalForm'] || [];
    const label = labels[0];
    const definitie = (props['definition'] || [])[0] || '';
    if (label && !label.startsWith('http')) {
      beroepen.push({ uri, label, definitie });
    }
  }
  console.log(`Beroepen gevonden voor "${searchTerm}":`, beroepen.map(b => b.label));
  return beroepen;
}

// Haal skills op bij beroep via occupations-id-02 (volledige URI)
async function haalSkillsBijBeroepURI(beroepUri, cnlKey) {
  // Probeer via occupations-id-02 met de volledige URI
  const encodedUri = encodeURIComponent(beroepUri);
  
  // Probeer meerdere endpoints
  const endpoints = [
    `/occupations-id-02/v1?uri=${encodedUri}&page=1&pageSize=200`,
    `/occupations-id-01/v1?uri=${encodedUri}&page=1&pageSize=200`,
    `/occupations-label-04/v1?uri=${encodedUri}&page=1&pageSize=200`,
    `/occupations-label-05/v1?uri=${encodedUri}&page=1&pageSize=200`,
  ];

  let data = {};
  for (const ep of endpoints) {
    const result = await cnlGet(ep, cnlKey);
    if (Object.keys(result).length > 5) {
      data = result;
      console.log(`Skills gevonden via ${ep}: ${Object.keys(result).length} entries`);
      break;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  return extractSkillsFromData(data);
}

function extractSkillsFromData(data) {
  const hardskills = [];
  const softskills = [];
  const softKeywords = ['communicer', 'samenwerk', 'overleg', 'leid', 'coach', 'motiveer',
    'empathie', 'flexibel', 'aanpass', 'initiatief', 'proactief', 'stress',
    'plannen', 'organiseer', 'priorit', 'besliss', 'contact', 'relatie',
    'presenteer', 'vergader', 'rapporteer', 'adviseer', 'onderhoud contact'];

  for (const [uri, props] of Object.entries(data)) {
    const labels = props['prefLabel'] || [];
    const label = labels.find(l => !l.startsWith('http')) || labels[0];
    if (!label || label.startsWith('http')) continue;

    const notation = (props['notation'] || [])[0] || null;
    const types = props['type'] || [];
    const escoUri = [...(props['closeMatchESCO'] || []), ...(props['exactMatch'] || [])].find(u => u.includes('europa.eu')) || null;

    const isKennisgebied = types.some(t => t.includes('KnowledgeDomain') || t.includes('knowledge'));
    const isHumanCap = types.some(t => t.includes('HumanCapability'));
    const isESCOSkill = uri.includes('data.europa.eu/esco/skill');
    const isCNLSkill = uri.includes('humancapability') || uri.includes('competentnl');

    if (!isKennisgebied && !isHumanCap && !isESCOSkill && !isCNLSkill) continue;

    const skill = { uri, label, notation, esco_uri: escoUri, cnl_matched: true };

    if (isKennisgebied) {
      hardskills.push({ ...skill, cnl_type: 'kennisgebied' });
    } else {
      const isSoft = softKeywords.some(k => label.toLowerCase().includes(k));
      if (isSoft) {
        softskills.push({ ...skill, cnl_type: 'softskill' });
      } else {
        hardskills.push({ ...skill, cnl_type: 'vaardigheid' });
      }
    }
  }

  return { hardskills, softskills };
}

// Fallback: zoek skills direct op termen via skills endpoints
async function zoekSkillsOpTerm(term, cnlKey) {
  const endpoints = [
    `/skills-label-08/v1?searchTerm=${encodeURIComponent(term)}&page=1&pageSize=50`,
    `/skills-label-23/v1?searchTerm=${encodeURIComponent(term)}&page=1&pageSize=50`,
    `/skills-label-24/v1?searchTerm=${encodeURIComponent(term)}&page=1&pageSize=50`,
  ];
  
  const allSkills = [];
  for (const ep of endpoints) {
    try {
      const data = await cnlGet(ep, cnlKey);
      const { hardskills, softskills } = extractSkillsFromData(data);
      [...hardskills, ...softskills].forEach(s => {
        if (!allSkills.find(x => x.label === s.label)) allSkills.push(s);
      });
      if (allSkills.length > 0) break; // stop bij eerste hit
      await new Promise(r => setTimeout(r, 150));
    } catch(e) { console.log('Skills zoek fout:', e.message); }
  }
  return allSkills;
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

async function genereerTaken(functieprofiel, bedrijf, eigenTaal, bronnen, apiKey) {
  return vraagClaude(
    `Je bent expert in functie-analyse en skills-based werken. Geef ALLEEN geldige JSON terug, geen markdown.`,
    `Analyseer dit functieprofiel grondig. Haal ALLE taken op:
1. Taken die expliciet in het profiel staan
2. Taken die standaard bij dit beroep horen (sectorkennis)
3. Taken die bij de context van het bedrijf horen

FUNCTIEPROFIEL: ${functieprofiel}
${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}
${eigenTaal ? `BEDRIJFSEIGEN TERMEN: ${eigenTaal}` : ''}
${bronnen ? `EXTRA CONTEXT WERKGEVER:\n${bronnen.slice(0, 2000)}` : ''}

JSON (direct, geen markdown):
{"functietitel":"string","samenvatting":"max 2 zinnen","vergelijkbare_titels":["string"],"taken":[{"id":"T01","taak":"concrete taakomschrijving","bron":"profiel|beroep|bedrijf","frequentie":"dagelijks|wekelijks|maandelijks","belang":"hoog|middel|laag","geselecteerd":true}]}

Genereer 15-30 taken. Wees volledig en concreet.`,
    apiKey
  );
}

// ─── Stap 2: Skills koppelen ─────────────────────────────────────────────────

async function koppelSkills(functietitel, taken, functieprofiel, bedrijf, eigenTaal, anthropicKey, cnlKey) {
  let alleHardskills = [];
  let alleSoftskills = [];

  // Stap A: Zoek beroep en haal skills op via beroeps-URI
  try {
    const beroepen = await zoekBeroepen(functietitel, cnlKey);
    
    if (beroepen.length > 0) {
      // Kies beste beroep
      let gekozenBeroep = beroepen[0];
      if (beroepen.length > 1) {
        try {
          const keuze = await vraagClaude(
            `Je bent expert in beroepsclassificatie. Geef ALLEEN geldige JSON terug.`,
            `Kies het meest passende beroep voor de functie "${functietitel}".
BEROEPEN:
${beroepen.slice(0,10).map((b,i) => `${i}: ${b.label} — ${b.definitie.slice(0,100)}`).join('\n')}
JSON: {"index": 0}`,
            anthropicKey, 500
          );
          const idx = Math.min(keuze.index || 0, beroepen.length - 1);
          gekozenBeroep = beroepen[idx];
        } catch(e) { console.log('Beroep keuze fout:', e.message); }
      }
      console.log(`Gekozen beroep: ${gekozenBeroep.label} — ${gekozenBeroep.uri}`);

      // Haal skills op bij dit beroep
      const { hardskills, softskills } = await haalSkillsBijBeroepURI(gekozenBeroep.uri, cnlKey);
      alleHardskills = [...hardskills];
      alleSoftskills = [...softskills];
      console.log(`Via beroep: ${hardskills.length} hardskills, ${softskills.length} softskills`);
    }

    // Stap B: als te weinig, zoek ook op kernwoorden via skills endpoints
    if (alleHardskills.length < 5) {
      console.log('Te weinig via beroep, zoek via skills endpoints...');
      
      // Extraheer kernwoorden uit functietitel en taken
      const kernwoorden = await vraagClaude(
        `Je bent expert in Nederlandse arbeidsmarktterminologie. Geef ALLEEN geldige JSON terug.`,
        `Extraheer de 8 belangrijkste Nederlandse vakinhoudelijke termen uit deze functie en taken.
Gebruik enkelvoud, losse woorden die matchen met ESCO/CompetentNL skillsnamen.

FUNCTIETITEL: ${functietitel}
TAKEN: ${taken.slice(0,10).map(t=>t.taak).join('; ')}

JSON: {"termen": ["term1", "term2", ...]}`,
        anthropicKey, 1000
      );

      for (const term of (kernwoorden.termen || []).slice(0, 8)) {
        try {
          const skills = await zoekSkillsOpTerm(term, cnlKey);
          skills.forEach(s => {
            const isSoft = s.cnl_type === 'softskill';
            if (isSoft) {
              if (!alleSoftskills.find(x => x.label === s.label)) alleSoftskills.push(s);
            } else {
              if (!alleHardskills.find(x => x.label === s.label)) alleHardskills.push(s);
            }
          });
          await new Promise(r => setTimeout(r, 200));
        } catch(e) { console.log(`Term fout "${term}":`, e.message); }
      }
      console.log(`Na fallback: ${alleHardskills.length} hardskills, ${alleSoftskills.length} softskills`);
    }

  } catch(e) {
    console.log('Skills zoek fout:', e.message);
  }

  // Stap C: Claude koppelt skills aan taken
  const takenTekst = taken.map(t => `- ${t.id}: ${t.taak}`).join('\n');
  const hardLijst = alleHardskills.map(s => `${s.label}|${s.notation || s.uri.split('/').pop()}`).join('\n');
  const softLijst = alleSoftskills.map(s => `${s.label}|${s.notation || s.uri.split('/').pop()}`).join('\n');
  const eigenTermenLijst = eigenTaal ? eigenTaal.split(/[,\n]/).map(t=>t.trim()).filter(Boolean) : [];

  const resultaat = await vraagClaude(
    `Je bent CompetentNL-expert en skills-analist. Geef ALLEEN geldige JSON terug, geen markdown.
KRITIEKE REGEL: gebruik skills UITSLUITEND uit de meegestuurde lijsten. Verzin NOOIT zelf skills.
MAX 3 hardskills en 2 softskills per taak.`,
    `Koppel CompetentNL-skills aan taken voor: ${functietitel}

TAKEN:
${takenTekst}
${bedrijf ? `BEDRIJF: ${bedrijf}` : ''}

BESCHIKBARE HARDSKILLS (label|code):
${hardLijst || '(geen gevonden via CompetentNL)'}

BESCHIKBARE SOFTSKILLS (label|code):
${softLijst || '(geen gevonden via CompetentNL)'}

JSON (direct, geen markdown):
{
  "taken": [{
    "id": "T01",
    "hardskills": [{
      "skill": "exacte label uit hardskills lijst",
      "cnl_code": "exacte code",
      "niveau": "Basis|Gevorderd|Expert",
      "bron": "profiel|beroep|bedrijf",
      "toelichting": "waarom relevant"
    }],
    "softskills": [{
      "softskill": "exacte label uit softskills lijst",
      "cnl_code": "exacte code",
      "niveau": "Basis|Gevorderd|Expert",
      "bron": "profiel|beroep|bedrijf",
      "toelichting": "waarom relevant"
    }]
  }]
}`,
    anthropicKey
  );

  // Lookup maps
  const hardLookup = new Map([
    ...alleHardskills.map(s => [s.label, s]),
    ...alleHardskills.filter(s=>s.notation).map(s => [s.notation, s]),
    ...alleHardskills.map(s => [s.uri.split('/').pop(), s]),
  ]);
  const softLookup = new Map([
    ...alleSoftskills.map(s => [s.label, s]),
    ...alleSoftskills.filter(s=>s.notation).map(s => [s.notation, s]),
    ...alleSoftskills.map(s => [s.uri.split('/').pop(), s]),
  ]);

  const enrichHard = (item) => {
    const gevonden = hardLookup.get(item.skill) || hardLookup.get(item.cnl_code);
    return { ...item, cnl_label: item.skill, cnl_code: gevonden?.notation||item.cnl_code||null, cnl_uri: gevonden?.uri||null, cnl_esco_uri: gevonden?.esco_uri||null, cnl_type: gevonden?.cnl_type||'hardskill', cnl_matched: !!gevonden };
  };
  const enrichSoft = (item) => {
    const gevonden = softLookup.get(item.softskill) || softLookup.get(item.cnl_code);
    return { ...item, cnl_label: item.softskill, cnl_code: gevonden?.notation||item.cnl_code||null, cnl_uri: gevonden?.uri||null, cnl_esco_uri: gevonden?.esco_uri||null, cnl_type: gevonden?.cnl_type||'softskill', cnl_matched: !!gevonden };
  };

  const eigenSoftskills = eigenTermenLijst.map(term => ({
    softskill: term, cnl_code: null, niveau: 'Gevorderd', bron: 'bedrijf',
    toelichting: 'Bedrijfseigen term', cnl_label: term, cnl_uri: null,
    cnl_esco_uri: null, cnl_type: 'eigen', cnl_matched: false, eigen: true,
  }));

  return {
    ...resultaat,
    taken: (resultaat.taken ?? []).map(taak => ({
      ...taak,
      hardskills: (taak.hardskills ?? []).map(enrichHard),
      softskills: [...(taak.softskills ?? []).map(enrichSoft), ...eigenSoftskills],
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
    const { stap, functieprofiel, functietitel, taken, bedrijf, eigenTaal, bronnen } = req.body ?? {};
    if (stap === 1) {
      if (!functieprofiel) return res.status(400).json({ error: 'functieprofiel verplicht' });
      return res.status(200).json(await genereerTaken(functieprofiel, bedrijf, eigenTaal, bronnen||'', anthropicKey));
    }
    if (stap === 2) {
      if (!taken?.length) return res.status(400).json({ error: 'taken verplicht' });
      return res.status(200).json(await koppelSkills(functietitel, taken, functieprofiel, bedrijf, eigenTaal, anthropicKey, cnlKey));
    }
    return res.status(400).json({ error: `Onbekende stap: ${stap}` });
  } catch (e) {
    console.error('Fout:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
