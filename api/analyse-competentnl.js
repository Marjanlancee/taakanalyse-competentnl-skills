// api/analyse-competentnl.js — Functieprofiel Decompositor CompetentNL v3
// GEOPTIMALISEERD: string concatenation ipv template literals, temperature:0

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const CNL_BASE = 'https://api.competentnl.nl';

function parseNTriples(text) {
  const triples = [];
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  for (const line of lines) {
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

function extractDefinitie(props) {
  // Probeer alle mogelijke predicate-namen voor definitie
  const kandidaten = [
    'hasDefinition',
    'definition',
    'description',
    'scopeNote',
    'comment',
    'abstract',
    'note',
    'altLabel',
  ];
  for (const k of kandidaten) {
    const val = (props[k] || []).find(v => v && v.length > 10 && !v.startsWith('http'));
    if (val) return val;
  }
  return null;
}

async function cnlGet(endpoint, cnlKey) {
  const url = CNL_BASE + endpoint;
  console.log('CNL GET:', url);
  const res = await fetch(url, {
    headers: { 'apikey': cnlKey, 'accept': 'application/n-triples' }
  });
  if (!res.ok) {
    const body = await res.text();
    console.log('CNL fout ' + res.status + ':', body.slice(0, 200));
    return {};
  }
  const text = await res.text();
  console.log('CNL response length: ' + text.length);
  if (!text || text.trim().length < 10) return {};
  const parsed = groupBySubject(parseNTriples(text));
  // Debug: log alle unieke predicate-keys voor de eerste skill
  const firstKey = Object.keys(parsed)[0];
  if (firstKey) {
    console.log('Predicate keys voor eerste entry:', Object.keys(parsed[firstKey]).join(', '));
  }
  return parsed;
}

async function zoekBeroepen(searchTerm, cnlKey) {
  const data = await cnlGet(
    '/occupations-label-01/v1?searchTerm=' + encodeURIComponent(searchTerm) + '&page=1&pageSize=20',
    cnlKey
  );
  const beroepen = [];
  for (const [uri, props] of Object.entries(data)) {
    if (!uri.includes('/occupation/') && !uri.includes('/uwv/')) continue;
    const labels = props['prefLabel'] || props['literalForm'] || [];
    const label = labels[0];
    const definitie = extractDefinitie(props) || '';
    if (label && !label.startsWith('http')) {
      beroepen.push({ uri, label, definitie });
    }
  }
  console.log('Beroepen gevonden voor "' + searchTerm + '":', beroepen.map(b => b.label));
  return beroepen;
}

async function haalSkillsBijBeroepURI(beroepUri, cnlKey) {
  const encodedUri = encodeURIComponent(beroepUri);
  const endpoints = [
    '/occupations-id-02/v1?uri=' + encodedUri + '&page=1&pageSize=200',
    '/occupations-id-01/v1?uri=' + encodedUri + '&page=1&pageSize=200',
    '/occupations-label-04/v1?uri=' + encodedUri + '&page=1&pageSize=200',
    '/occupations-label-05/v1?uri=' + encodedUri + '&page=1&pageSize=200',
  ];
  let data = {};
  for (const ep of endpoints) {
    const result = await cnlGet(ep, cnlKey);
    if (Object.keys(result).length > 5) {
      data = result;
      console.log('Skills gevonden via ' + ep + ': ' + Object.keys(result).length + ' entries');
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
    'organiseer', 'priorit', 'besliss', 'contact onderhoud', 'relatiebeheer',
    'presenteer', 'vergader', 'integriteit', 'zelfstandig werk', 'klantgerich',
    'resultaatgerich', 'omgaan met', 'sociale vaardig'];

  for (const [uri, props] of Object.entries(data)) {
    const labels = props['prefLabel'] || [];
    const label = labels.find(l => !l.startsWith('http')) || labels[0];
    if (!label || label.startsWith('http')) continue;
    const notation = (props['notation'] || [])[0] || null;
    const types = props['type'] || [];
    const escoUri = [...(props['closeMatchESCO'] || []), ...(props['exactMatch'] || [])].find(u => u.includes('europa.eu')) || null;
    const definitie = extractDefinitie(props);
    const isKennisgebied = types.some(t => t.includes('KnowledgeDomain') || t.includes('knowledge'));
    const isHumanCap = types.some(t => t.includes('HumanCapability'));
    const isESCOSkill = uri.includes('data.europa.eu/esco/skill');
    const isCNLSkill = uri.includes('humancapability') || uri.includes('competentnl');
    if (!isKennisgebied && !isHumanCap && !isESCOSkill && !isCNLSkill) continue;
    const skill = { uri, label, notation, esco_uri: escoUri, definitie, cnl_matched: true };
    if (isKennisgebied) {
      hardskills.push({ ...skill, cnl_type: 'kennisgebied' });
    } else {
      const isSoft = softKeywords.some(k => label.toLowerCase().includes(k));
      if (isSoft) softskills.push({ ...skill, cnl_type: 'softskill' });
      else hardskills.push({ ...skill, cnl_type: 'vaardigheid' });
    }
  }
  return { hardskills, softskills };
}

async function zoekSkillsOpTerm(term, cnlKey) {
  const endpoints = [
    '/skills-label-08/v1?searchTerm=' + encodeURIComponent(term) + '&page=1&pageSize=50',
    '/skills-label-23/v1?searchTerm=' + encodeURIComponent(term) + '&page=1&pageSize=50',
  ];
  const allSkills = [];
  for (const ep of endpoints) {
    try {
      const data = await cnlGet(ep, cnlKey);
      const { hardskills, softskills } = extractSkillsFromData(data);
      [...hardskills, ...softskills].forEach(s => {
        if (!allSkills.find(x => x.label === s.label)) allSkills.push(s);
      });
      if (allSkills.length > 0) break;
      await new Promise(r => setTimeout(r, 150));
    } catch(e) { console.log('Skills zoek fout:', e.message); }
  }
  return allSkills;
}

function herstelJson(json) {
  try { JSON.parse(json); return json; } catch { /**/ }
  const opens = [];
  let inStr = false, esc = false;
  for (const c of json) {
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') opens.push('}');
    else if (c === '[') opens.push(']');
    else if (c === '}' || c === ']') opens.pop();
  }
  let r = json.trimEnd().replace(/,\s*$/, '').replace(/,\s*([}\]])/g, '$1');
  for (let i = opens.length - 1; i >= 0; i--) r += opens[i];
  return r;
}

async function vraagClaude(sys, prompt, apiKey, maxTokens) {
  maxTokens = maxTokens || 16000;
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      temperature: 0,
      system: sys,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error('Claude API fout: ' + res.status + ' - ' + await res.text());
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

async function genereerTaken(functieprofiel, bedrijf, eigenTaal, bronnen, pdfTekst, apiKey) {
  const bronnenTekst = Array.isArray(bronnen) ? bronnen.join('\n') : (bronnen || '');
  const prompt = 'Analyseer dit functieprofiel grondig. Haal ALLE taken op:\n'
    + '1. Taken die expliciet in het profiel staan\n'
    + '2. Taken die standaard bij dit beroep horen (sectorkennis)\n'
    + '3. Taken die bij de context van het bedrijf horen\n'
    + (bronnenTekst ? '4. Taken die blijken uit de aanvullende bronnen\n' : '')
    + '\nFUNCTIEPROFIEL: ' + functieprofiel
    + (bedrijf ? '\nBEDRIJF: ' + bedrijf : '')
    + (eigenTaal ? '\nBEDRIJFSEIGEN TERMEN: ' + eigenTaal : '')
    + (bronnenTekst ? '\nAANVULLENDE BRONNEN:\n' + bronnenTekst : '')
    + (pdfTekst ? '\nPDF INHOUD:\n' + pdfTekst.slice(0, 3000) : '')
    + '\n\nJSON (direct, geen markdown):\n'
    + '{"functietitel":"string","samenvatting":"max 2 zinnen","vergelijkbare_titels":["string"],"taken":[{"id":"T01","taak":"concrete taakomschrijving","bron":"profiel|beroep|bedrijf|bron","frequentie":"dagelijks|wekelijks|maandelijks","belang":"hoog|middel|laag","geselecteerd":true}]}\n\n'
    + 'Genereer 15-25 taken. Wees volledig en concreet.';

  return vraagClaude(
    'Je bent expert in functie-analyse en skills-based werken. Geef ALLEEN geldige JSON terug, geen markdown.',
    prompt,
    apiKey
  );
}

async function genereerDefinities(skills, apiKey) {
  // Fallback: Claude genereert definities voor skills zonder CNL-definitie
  const zonderDef = skills.filter(s => !s.definitie);
  if (zonderDef.length === 0) return skills;

  const lijst = zonderDef.map((s, i) => i + ': ' + s.label).join('\n');
  try {
    const result = await vraagClaude(
      'Je bent expert in Nederlandse HR en competentiemanagement. Geef ALLEEN geldige JSON terug.',
      'Geef voor elke skill een korte Nederlandse definitie (1-2 zinnen, max 150 tekens).\n\n'
      + 'SKILLS:\n' + lijst + '\n\n'
      + 'JSON: {"definities": ["definitie voor skill 0", "definitie voor skill 1", ...]}',
      apiKey, 2000
    );
    const defs = result.definities || [];
    let idx = 0;
    return skills.map(s => {
      if (!s.definitie) {
        s.definitie = defs[idx] || '';
        idx++;
      }
      return s;
    });
  } catch(e) {
    console.log('Definitie generatie fout:', e.message);
    return skills;
  }
}

async function koppelSkills(functietitel, taken, functieprofiel, bedrijf, eigenTaal, anthropicKey, cnlKey) {
  let alleHardskills = [];
  let alleSoftskills = [];

  try {
    const beroepen = await zoekBeroepen(functietitel, cnlKey);
    if (beroepen.length > 0) {
      let gekozenBeroep = beroepen[0];
      if (beroepen.length > 1) {
        try {
          const beroepLijst = beroepen.slice(0, 10).map((b, i) => i + ': ' + b.label + ' - ' + b.definitie.slice(0, 100)).join('\n');
          const keuze = await vraagClaude(
            'Je bent expert in beroepsclassificatie. Geef ALLEEN geldige JSON terug.',
            'Kies het meest passende beroep voor de functie "' + functietitel + '".\nBEROEPEN:\n' + beroepLijst + '\nJSON: {"index": 0}',
            anthropicKey, 500
          );
          const idx = Math.min(keuze.index || 0, beroepen.length - 1);
          gekozenBeroep = beroepen[idx];
        } catch(e) { console.log('Beroep keuze fout:', e.message); }
      }
      console.log('Gekozen beroep: ' + gekozenBeroep.label + ' - ' + gekozenBeroep.uri);
      const { hardskills, softskills } = await haalSkillsBijBeroepURI(gekozenBeroep.uri, cnlKey);
      alleHardskills = [...hardskills];
      alleSoftskills = [...softskills];
      console.log('Via beroep: ' + hardskills.length + ' hardskills, ' + softskills.length + ' softskills');
    }

    if (alleHardskills.length < 5) {
      console.log('Te weinig via beroep, zoek via skills endpoints...');
      const takenTekstKort = taken.slice(0, 10).map(t => t.taak).join('; ');
      const kernwoorden = await vraagClaude(
        'Je bent expert in Nederlandse arbeidsmarktterminologie. Geef ALLEEN geldige JSON terug.',
        'Extraheer de 8 belangrijkste Nederlandse vakinhoudelijke termen uit deze functie en taken.\n'
        + 'Gebruik enkelvoud, losse woorden die matchen met ESCO/CompetentNL skillsnamen.\n\n'
        + 'FUNCTIETITEL: ' + functietitel + '\n'
        + 'TAKEN: ' + takenTekstKort + '\n\n'
        + 'JSON: {"termen": ["term1", "term2"]}',
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
        } catch(e) { console.log('Term fout "' + term + '":', e.message); }
      }
      console.log('Na fallback: ' + alleHardskills.length + ' hardskills, ' + alleSoftskills.length + ' softskills');
    }
  } catch(e) {
    console.log('Skills zoek fout:', e.message);
  }

  const takenTekst = taken.map(t => '- ' + t.id + ': ' + t.taak).join('\n');
  const hardLijst = alleHardskills.map(s => s.label + '|' + (s.notation || s.uri.split('/').pop())).join('\n');
  const softLijst = alleSoftskills.map(s => s.label + '|' + (s.notation || s.uri.split('/').pop())).join('\n');
  const eigenTermenLijst = eigenTaal ? eigenTaal.split(/[,\n]/).map(t => t.trim()).filter(Boolean) : [];

  const koppelPrompt = 'Koppel CompetentNL-skills aan taken voor: ' + functietitel + '\n\n'
    + 'TAKEN:\n' + takenTekst + '\n'
    + (bedrijf ? 'BEDRIJF: ' + bedrijf + '\n' : '')
    + '\nBESCHIKBARE HARDSKILLS (label|code):\n' + (hardLijst || '(geen gevonden via CompetentNL)')
    + '\n\nBESCHIKBARE SOFTSKILLS (label|code):\n' + (softLijst || '(geen gevonden via CompetentNL)')
    + '\n\nJSON (direct, geen markdown):\n'
    + '{"taken":[{"id":"T01","hardskills":[{"skill":"exacte label","cnl_code":"exacte code","niveau":"Basis|Gevorderd|Expert","bron":"profiel|beroep|bedrijf","toelichting":"waarom relevant"}],"softskills":[{"softskill":"exacte label","cnl_code":"exacte code","niveau":"Basis|Gevorderd|Expert","bron":"profiel|beroep|bedrijf","toelichting":"waarom relevant"}]}]}';

  const resultaat = await vraagClaude(
    'Je bent CompetentNL-expert en skills-analist. Geef ALLEEN geldige JSON terug, geen markdown.\n'
    + 'KRITIEKE REGEL: gebruik skills UITSLUITEND uit de meegestuurde lijsten. Verzin NOOIT zelf skills.\n'
    + 'MAX 3 hardskills en 2 softskills per taak.',
    koppelPrompt,
    anthropicKey
  );

  const hardLookup = new Map([
    ...alleHardskills.map(s => [s.label, s]),
    ...alleHardskills.filter(s => s.notation).map(s => [s.notation, s]),
    ...alleHardskills.map(s => [s.uri.split('/').pop(), s]),
  ]);
  const softLookup = new Map([
    ...alleSoftskills.map(s => [s.label, s]),
    ...alleSoftskills.filter(s => s.notation).map(s => [s.notation, s]),
    ...alleSoftskills.map(s => [s.uri.split('/').pop(), s]),
  ]);

  const enrichHard = (item) => {
    const g = hardLookup.get(item.skill) || hardLookup.get(item.cnl_code);
    return { ...item, cnl_label: item.skill, cnl_code: g?.notation || item.cnl_code || null, cnl_uri: g?.uri || null, cnl_esco_uri: g?.esco_uri || null, cnl_type: g?.cnl_type || 'hardskill', cnl_definitie: g?.definitie || null, cnl_matched: !!g };
  };
  const enrichSoft = (item) => {
    const g = softLookup.get(item.softskill) || softLookup.get(item.cnl_code);
    return { ...item, cnl_label: item.softskill, cnl_code: g?.notation || item.cnl_code || null, cnl_uri: g?.uri || null, cnl_esco_uri: g?.esco_uri || null, cnl_type: g?.cnl_type || 'softskill', cnl_definitie: g?.definitie || null, cnl_matched: !!g };
  };

  const eigenSoftskills = eigenTermenLijst.map(term => ({
    softskill: term, cnl_code: null, niveau: 'Gevorderd', bron: 'bedrijf',
    toelichting: 'Bedrijfseigen term', cnl_label: term, cnl_uri: null,
    cnl_esco_uri: null, cnl_type: 'eigen', cnl_matched: false, eigen: true,
  }));

  const verrijktResultaat = {
    ...resultaat,
    taken: (resultaat.taken ?? []).map(taak => ({
      ...taak,
      hardskills: (taak.hardskills ?? []).map(enrichHard),
      softskills: [...(taak.softskills ?? []).map(enrichSoft), ...eigenSoftskills],
    })),
  };

  // Verzamel unieke skills zonder definitie en genereer ze via Claude als fallback
  const skillsZonderDef = [];
  const skillDefMap = new Map();
  verrijktResultaat.taken.forEach(taak => {
    [...(taak.hardskills || []), ...(taak.softskills || [])].forEach(s => {
      const naam = s.cnl_label || s.skill || s.softskill || '';
      if (naam && !s.cnl_definitie && !skillDefMap.has(naam)) {
        skillDefMap.set(naam, null);
        skillsZonderDef.push({ label: naam });
      }
    });
  });

  if (skillsZonderDef.length > 0) {
    console.log('Genereer definities voor ' + skillsZonderDef.length + ' skills via Claude...');
    const metDef = await genereerDefinities(skillsZonderDef, anthropicKey);
    metDef.forEach(s => skillDefMap.set(s.label, s.definitie || ''));

    // Voeg definities toe aan resultaat
    verrijktResultaat.taken = verrijktResultaat.taken.map(taak => ({
      ...taak,
      hardskills: (taak.hardskills || []).map(s => ({
        ...s,
        cnl_definitie: s.cnl_definitie || skillDefMap.get(s.cnl_label || s.skill) || ''
      })),
      softskills: (taak.softskills || []).map(s => ({
        ...s,
        cnl_definitie: s.cnl_definitie || skillDefMap.get(s.cnl_label || s.softskill) || ''
      })),
    }));
  }

  return verrijktResultaat;
}

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
    const { stap, functieprofiel, functietitel, taken, bedrijf, eigenTaal, bronnen, pdfTekst } = req.body ?? {};
    if (stap === 1) {
      if (!functieprofiel) return res.status(400).json({ error: 'functieprofiel verplicht' });
      return res.status(200).json(await genereerTaken(functieprofiel, bedrijf, eigenTaal, bronnen || [], pdfTekst || '', anthropicKey));
    }
    if (stap === 2) {
      if (!taken?.length) return res.status(400).json({ error: 'taken verplicht' });
      return res.status(200).json(await koppelSkills(functietitel, taken, functieprofiel, bedrijf, eigenTaal, anthropicKey, cnlKey));
    }
    return res.status(400).json({ error: 'Onbekende stap: ' + stap });
  } catch (e) {
    console.error('Fout:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
