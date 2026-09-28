/* Presentation preferences stay in webview state; model output is never translated. */
window.CodeFlareUI = (() => {
  const languages = ['en', 'nl', 'fr', 'de'];
  // Each language named in ITSELF: a flag's label must be readable by someone
  // who cannot read the language currently shown.
  const NATIVE_NAMES = { en: 'English', nl: 'Nederlands', fr: 'Français', de: 'Deutsch' };
  // Flags as SVG shapes. Windows does not render regional-indicator flag emoji
  // (🇳🇱 shows as the letters "NL"), and VS Code on Windows is the main target.
  const FLAGS = {
    en: { viewBox: '0 0 60 30', parts: [
      ['rect', { width: 60, height: 30, fill: '#012169' }],
      ['path', { d: 'M0,0 L60,30 M60,0 L0,30', fill: 'none', stroke: '#FFFFFF', 'stroke-width': 6 }],
      ['path', { d: 'M0,0 L60,30 M60,0 L0,30', fill: 'none', stroke: '#C8102E', 'stroke-width': 2 }],
      ['path', { d: 'M30,0 V30 M0,15 H60', fill: 'none', stroke: '#FFFFFF', 'stroke-width': 10 }],
      ['path', { d: 'M30,0 V30 M0,15 H60', fill: 'none', stroke: '#C8102E', 'stroke-width': 6 }],
    ] },
    nl: { viewBox: '0 0 9 6', parts: [
      ['rect', { y: 0, width: 9, height: 2, fill: '#AE1C28' }],
      ['rect', { y: 2, width: 9, height: 2, fill: '#FFFFFF' }],
      ['rect', { y: 4, width: 9, height: 2, fill: '#21468B' }],
    ] },
    fr: { viewBox: '0 0 9 6', parts: [
      ['rect', { x: 0, width: 3, height: 6, fill: '#0055A4' }],
      ['rect', { x: 3, width: 3, height: 6, fill: '#FFFFFF' }],
      ['rect', { x: 6, width: 3, height: 6, fill: '#EF4135' }],
    ] },
    de: { viewBox: '0 0 9 6', parts: [
      ['rect', { y: 0, width: 9, height: 2, fill: '#000000' }],
      ['rect', { y: 2, width: 9, height: 2, fill: '#DD0000' }],
      ['rect', { y: 4, width: 9, height: 2, fill: '#FFCE00' }],
    ] },
  };
  /** Build a flag through the DOM API — no markup strings, nothing parsed. */
  function flagSvg(code) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', FLAGS[code].viewBox);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const [tag, attrs] of FLAGS[code].parts) {
      const part = document.createElementNS(ns, tag);
      for (const [name, value] of Object.entries(attrs)) { part.setAttribute(name, String(value)); }
      svg.append(part);
    }
    return svg;
  }
  const dictionary = new Map();
  function add(en, nl, fr, de) { dictionary.set(en, [en, nl, fr, de]); }
  add('Settings', 'Instellingen', 'Réglages', 'Einstellungen');
  add('Connection', 'Verbinding', 'Connexion', 'Verbindung');
  add('Commands', 'Opdrachten', 'Commandes', 'Befehle');
  add('Agents', 'Agents', 'Agents', 'Agenten');
  add('Budget', 'Budget', 'Budget', 'Budget');
  add('Memory', 'Geheugen', 'Mémoire', 'Speicher');
  add('Help', 'Hulp', 'Aide', 'Hilfe');
  // Memory map (media/memoryMap.js)
  add('Memory map', 'Geheugenkaart', 'Carte de la mémoire', 'Speicherkarte');
  add('Loading the memory map…', 'Geheugenkaart laden…', 'Chargement de la carte…', 'Speicherkarte wird geladen…');
  add('In every prompt', 'In elke prompt', 'Dans chaque prompt', 'In jedem Prompt');
  add('Every turn starts with these, in this project.', 'Elke beurt begint hiermee, in dit project.', 'Chaque tour commence avec ceci, dans ce projet.', 'Jede Runde beginnt damit, in diesem Projekt.');
  add('Automatically, when relevant', 'Automatisch, als het relevant is', 'Automatiquement, si pertinent', 'Automatisch, wenn relevant');
  add('Up to 5 that match the request are added to the prompt.', 'Maximaal 5 die bij de vraag passen gaan mee in de prompt.', 'Jusqu’à 5 correspondant à la demande sont ajoutées au prompt.', 'Bis zu 5 passende werden dem Prompt hinzugefügt.');
  add('Only on request', 'Alleen op verzoek', 'Uniquement sur demande', 'Nur auf Anfrage');
  add('The agent sees these only when it calls recall_memory or list_skills itself.', 'De agent ziet dit alleen als hij zelf recall_memory of list_skills aanroept.', 'L’agent ne les voit que s’il appelle lui-même recall_memory ou list_skills.', 'Der Agent sieht dies nur, wenn er selbst recall_memory oder list_skills aufruft.');
  add('Stored, not read back', 'Opgeslagen, niet teruggelezen', 'Stocké, jamais relu', 'Gespeichert, nicht zurückgelesen');
  add('Written with record_landscape; nothing reads them back into a prompt yet.', 'Geschreven met record_landscape; nog niets leest ze terug in een prompt.', 'Écrits avec record_landscape ; rien ne les relit encore dans un prompt.', 'Mit record_landscape geschrieben; noch nichts liest sie in einen Prompt zurück.');
  add('Night Shift', 'Nachtdienst', 'Équipe de nuit', 'Nachtschicht');
  add('Night Shift picks its next goal from these.', 'De nachtdienst kiest hieruit zijn volgende doel.', 'L’équipe de nuit y choisit son prochain objectif.', 'Die Nachtschicht wählt hieraus ihr nächstes Ziel.');
  add('Facts in every prompt', 'Feiten in elke prompt', 'Faits dans chaque prompt', 'Fakten in jedem Prompt');
  add('Validated skills', 'Gevalideerde vaardigheden', 'Compétences validées', 'Validierte Fähigkeiten');
  add('Experiences', 'Ervaringen', 'Expériences', 'Erfahrungen');
  add('Candidate skills', 'Kandidaat-vaardigheden', 'Compétences candidates', 'Kandidaten-Fähigkeiten');
  add('No experiments recorded yet.', 'Nog geen experimenten vastgelegd.', 'Aucune expérience enregistrée.', 'Noch keine Experimente gespeichert.');
  add('No candidates.', 'Geen kandidaten.', 'Aucune candidate.', 'Keine Kandidaten.');
  add('Nothing validated yet.', 'Nog niets gevalideerd.', 'Rien de validé pour l’instant.', 'Noch nichts validiert.');
  add('reflection or save_skill', 'reflectie of save_skill', 'réflexion ou save_skill', 'Reflexion oder save_skill');
  add('proven in a mission with tests', 'bewezen in een missie met tests', 'prouvée dans une mission avec tests', 'in einer Mission mit Tests bewiesen');
  add('Facts (memory.md)', 'Feiten (memory.md)', 'Faits (memory.md)', 'Fakten (memory.md)');
  add('No facts stored.', 'Geen feiten opgeslagen.', 'Aucun fait enregistré.', 'Keine Fakten gespeichert.');
  add('Goals and acceptance criteria', 'Doelen en acceptatiecriteria', 'Objectifs et critères d’acceptation', 'Ziele und Akzeptanzkriterien');
  add('No goals recorded.', 'Geen doelen vastgelegd.', 'Aucun objectif enregistré.', 'Keine Ziele gespeichert.');
  add('Backlog', 'Backlog', 'Backlog', 'Backlog');
  add('Backlog is empty.', 'Backlog is leeg.', 'Le backlog est vide.', 'Backlog ist leer.');
  add('What the checks observed', 'Wat de controles zagen', 'Ce que les vérifications ont observé', 'Was die Prüfungen beobachtet haben');
  add('Failed checks', 'Mislukte controles', 'Vérifications échouées', 'Fehlgeschlagene Prüfungen');
  add('Summary', 'Samenvatting', 'Résumé', 'Zusammenfassung');
  add('When to use', 'Wanneer te gebruiken', 'Quand l’utiliser', 'Wann verwenden');
  add('Measured lift (with vs. without)', 'Gemeten effect (met vs. zonder)', 'Effet mesuré (avec vs. sans)', 'Gemessener Effekt (mit vs. ohne)');
  add('Acceptance criteria', 'Acceptatiecriteria', 'Critères d’acceptation', 'Akzeptanzkriterien');
  add('Decisions', 'Beslissingen', 'Décisions', 'Entscheidungen');
  add('Select an item to see what is stored.', 'Kies een onderdeel om te zien wat er is opgeslagen.', 'Choisissez un élément pour voir ce qui est stocké.', 'Wähle einen Eintrag, um zu sehen, was gespeichert ist.');
  add('Refresh', 'Vernieuwen', 'Actualiser', 'Aktualisieren');
  add('This project', 'Dit project', 'Ce projet', 'Dieses Projekt');
  add('stays in this workspace', 'blijft in deze werkmap', 'reste dans cet espace de travail', 'bleibt in diesem Arbeitsbereich');
  add('No project storage in this window: open a folder to see what it learned.', 'Geen projectopslag in dit venster: open een map om te zien wat daar geleerd is.', 'Pas de stockage de projet dans cette fenêtre : ouvrez un dossier pour voir ce qu’il a appris.', 'Kein Projektspeicher in diesem Fenster: Öffne einen Ordner, um zu sehen, was dort gelernt wurde.');
  add('Older experiences not drawn:', 'Oudere ervaringen niet getekend:', 'Expériences plus anciennes non affichées :', 'Ältere Erfahrungen nicht gezeigt:');
  add('Agent memory', 'Agentgeheugen', 'Mémoire de l’agent', 'Agentenspeicher');
  add('shared by all projects', 'gedeeld door alle projecten', 'partagée par tous les projets', 'von allen Projekten geteilt');
  add('How each part reaches the agent', 'Hoe elk deel bij de agent komt', 'Comment chaque partie atteint l’agent', 'Wie jeder Teil den Agenten erreicht');
  add('accepted', 'geaccepteerd', 'acceptée', 'akzeptiert');
  add('inconclusive', 'onbeslist', 'non concluante', 'ergebnislos');
  add('rejected', 'afgewezen', 'rejetée', 'abgelehnt');
  add('some checks failed', 'sommige controles mislukt', 'certaines vérifications ont échoué', 'einige Prüfungen fehlgeschlagen');
  add('Memory storage is unavailable in this window.', 'Geheugenopslag is niet beschikbaar in dit venster.', 'Le stockage de la mémoire n’est pas disponible dans cette fenêtre.', 'Speicher ist in diesem Fenster nicht verfügbar.');
  add('Language', 'Taal', 'Langue', 'Sprache');
  add('Light mode', 'Lichte modus', 'Mode clair', 'Heller Modus');
  add('Dark mode', 'Donkere modus', 'Mode sombre', 'Dunkler Modus');
  add('Close', 'Sluiten', 'Fermer', 'Schließen');
  add('model name', 'Modelnaam', 'Nom du modèle', 'Modellname');
  add('Attach files (images, text, json, …)', 'Bestanden toevoegen (afbeeldingen, tekst, json, …)', 'Joindre des fichiers (images, texte, json, …)', 'Dateien anhängen (Bilder, Text, JSON, …)');
  add('Copy chat + extension log to clipboard', 'Chat en extensielog kopiëren', 'Copier le chat et le journal de l’extension', 'Chat und Erweiterungsprotokoll kopieren');
  add('Export chat as markdown (with screenshots)', 'Chat exporteren als Markdown (met schermafbeeldingen)', 'Exporter le chat en Markdown (avec captures)', 'Chat als Markdown exportieren (mit Screenshots)');
  add('Clear chat', 'Chat wissen', 'Effacer le chat', 'Chat leeren');
  add('Stop generation', 'Genereren stoppen', 'Arrêter la génération', 'Generierung stoppen');
  add('Send (Enter)', 'Versturen (Enter)', 'Envoyer (Entrée)', 'Senden (Enter)');
  add('Show or hide the plan column', 'Takenlijst tonen of verbergen', 'Afficher ou masquer les tâches', 'Aufgabenliste ein- oder ausblenden');
  add('Settings: provider, model, token, commands, agents, memory', 'Instellingen voor verbinding, opdrachten, agents, budget en geheugen', 'Réglages de connexion, commandes, agents, budget et mémoire', 'Einstellungen für Verbindung, Befehle, Agenten, Budget und Speicher');
  add('Opties voor de volgende opdracht', 'Opties voor de volgende opdracht', 'Options pour la prochaine tâche', 'Optionen für die nächste Aufgabe');
  dictionary.get('Opties voor de volgende opdracht')[0] = 'Options for the next task';
  add('Klaar', 'Klaar', 'Terminé', 'Erledigt'); dictionary.get('Klaar')[0] = 'Done';
  add('Te doen', 'Te doen', 'À faire', 'Offen'); dictionary.get('Te doen')[0] = 'To do';
  add('Plan verbergen (komt terug bij de volgende update)', 'Taken verbergen (verschijnen bij de volgende update)', 'Masquer les tâches (réapparaissent à la prochaine mise à jour)', 'Aufgaben ausblenden (erscheinen beim nächsten Update)');
  dictionary.get('Plan verbergen (komt terug bij de volgende update)')[0] = 'Hide tasks (reappear on the next update)';
  add('Save', 'Opslaan', 'Enregistrer', 'Speichern');
  add('Cancel', 'Annuleren', 'Annuler', 'Abbrechen');
  add('Send', 'Versturen', 'Envoyer', 'Senden');
  add('Stop', 'Stoppen', 'Arrêter', 'Stoppen');
  add('Clear', 'Wissen', 'Effacer', 'Leeren');
  add('Provider', 'Aanbieder', 'Fournisseur', 'Anbieter');
  add('Endpoint URL', 'Serveradres (URL)', 'Adresse du serveur (URL)', 'Serveradresse (URL)');
  add('Model', 'Model', 'Modèle', 'Modell');
  add('API token', 'API-sleutel', 'Clé API', 'API-Schlüssel');
  add('Local (OpenAI-compatible)', 'Lokaal (OpenAI-compatibel)', 'Local (compatible OpenAI)', 'Lokal (OpenAI-kompatibel)');
  add('leave blank for none', 'Leeg laten zonder sleutel', 'Laisser vide sans clé', 'Ohne Schlüssel leer lassen');
  add('A token is stored. Leave blank to keep it, or type a new one.', 'Er is een sleutel opgeslagen. Laat leeg om die te behouden of voer een nieuwe in.', 'Une clé est enregistrée. Laissez vide pour la conserver ou saisissez une nouvelle clé.', 'Ein Schlüssel ist gespeichert. Leer lassen, um ihn zu behalten, oder einen neuen eingeben.');
  add('Any OpenAI-compatible server (VLLM, llama.cpp, Ollama). Token is optional.', 'Verbind met een OpenAI-compatibele server zoals vLLM, llama.cpp of Ollama. Een sleutel is optioneel.', 'Connectez un serveur compatible OpenAI : vLLM, llama.cpp ou Ollama. La clé est facultative.', 'Mit einem OpenAI-kompatiblen Server wie vLLM, llama.cpp oder Ollama verbinden. Der Schlüssel ist optional.');
  add('OpenAI API. A token (API key) is required.', 'Voor de OpenAI API is een API-sleutel nodig.', 'Une clé API est requise pour OpenAI.', 'Für die OpenAI API ist ein API-Schlüssel erforderlich.');
  add('Claude via the native Messages API. A token (Anthropic API key) is required.', 'Claude via de Messages API. Een Anthropic API-sleutel is nodig.', 'Claude via Messages API. Une clé API Anthropic est requise.', 'Claude über die Messages API. Ein Anthropic-API-Schlüssel ist erforderlich.');
  add('Ask before the agent runs a command (except trusted ones below)', 'Vraag toestemming voor opdrachten, behalve vertrouwde opdrachten hieronder', 'Demander avant une commande, sauf celles autorisées ci-dessous', 'Vor Befehlen nachfragen, außer bei den unten als vertrauenswürdig eingestuften');
  add('Trusted commands — run without asking (one per line)', 'Vertrouwde opdrachten — zonder bevestiging (één per regel)', 'Commandes autorisées sans confirmation (une par ligne)', 'Vertrauenswürdige Befehle ohne Rückfrage (einer pro Zeile)');
  add('A command runs without a prompt if it equals or starts with one of these. Keep this list to safe, non-destructive commands.', 'Opdrachten die hiermee beginnen worden zonder bevestiging uitgevoerd. Voeg alleen veilige opdrachten toe.', 'Les commandes commençant par ces préfixes sont exécutées sans confirmation. Utilisez uniquement des commandes sûres.', 'Befehle mit diesen Präfixen werden ohne Rückfrage ausgeführt. Nur sichere Befehle eintragen.');
  add('Maximaal gelijktijdige subagents', 'Maximaal gelijktijdige subagents', 'Sous-agents simultanés maximum', 'Maximal gleichzeitige Unteragenten');
  dictionary.get('Maximaal gelijktijdige subagents')[0] = 'Maximum simultaneous subagents';
  add('1–32 agents. De hoofdagent kiest hoeveel agents nodig zijn. Wachtende taken tellen niet als actief; alle subagents delen deze limiet.', '1–32 agents. De hoofdagent bepaalt het aantal. Wachtende taken tellen niet mee; alle subagents delen deze limiet.', '1 à 32 agents. L’agent principal choisit le nombre nécessaire. Les tâches en attente ne comptent pas ; tous les sous-agents partagent cette limite.', '1–32 Agenten. Der Hauptagent bestimmt die Anzahl. Wartende Aufgaben zählen nicht; alle Unteragenten teilen dieses Limit.');
  dictionary.get('1–32 agents. De hoofdagent kiest hoeveel agents nodig zijn. Wachtende taken tellen niet als actief; alle subagents delen deze limiet.')[0] = '1–32 agents. The main agent chooses how many are needed. Queued tasks do not count; all subagents share this limit.';
  const budgets = [
    ['Maximaal aantal turns', 'Maximum turns', 'Nombre maximal de tours', 'Maximale Anzahl Durchläufe'],
    ['Maximaal aantal tool calls', 'Maximum tool calls', 'Nombre maximal d’appels d’outils', 'Maximale Werkzeugaufrufe'],
    ['Maximaal aantal tokens', 'Maximum tokens', 'Nombre maximal de tokens', 'Maximale Tokens'],
    ['Maximale modeltijd (minuten)', 'Maximum model time (minutes)', 'Durée maximale du modèle (minutes)', 'Maximale Modellzeit (Minuten)'],
    ['Pauzeren na turns zonder voortgang', 'Pause after turns without progress', 'Suspendre après des tours sans progrès', 'Nach Durchläufen ohne Fortschritt pausieren'],
  ];
  budgets.push(
    ['Onbeperkt', 'Unlimited', 'Illimité', 'Unbegrenzt'],
    ['Onbeperkt bij een lokaal model', 'Unlimited with a local model', 'Illimité avec un modèle local', 'Unbegrenzt bei einem lokalen Modell'],
    ['Plafonds voor één autonome missie als geheel (alle turns, herstelrondes en teststap). Een missie die een plafond bereikt wordt gepauzeerd met de reden. Interactieve missies worden nooit begrensd.',
      'Ceilings for one autonomous mission as a whole (all turns, repair rounds and the test step). A mission that reaches a ceiling is paused with the reason. Interactive missions are never limited.',
      'Plafonds pour une mission autonome entière (tous les tours, rondes de réparation et étape de test). Une mission qui atteint un plafond est mise en pause avec la raison. Les missions interactives ne sont jamais limitées.',
      'Obergrenzen für eine autonome Mission als Ganzes (alle Durchläufe, Reparaturrunden und Testschritt). Eine Mission, die eine Grenze erreicht, wird mit Begründung pausiert. Interaktive Missionen werden nie begrenzt.'],
  );
  budgets.forEach(([nl, en, fr, de]) => dictionary.set(nl, [en, nl, fr, de]));
  add('Mission limits', 'Missielimieten', 'Limites de mission', 'Missionslimits');
  add('Limits apply to the whole autonomous mission, including recovery and tests. 0 means unlimited. The mission pauses when a limit is reached. Interactive missions are not limited.', 'Limieten gelden voor de hele autonome missie, inclusief herstel en tests. 0 betekent onbeperkt. Bij het bereiken van een limiet pauzeert de missie. Interactieve missies zijn niet begrensd.', 'Les limites couvrent toute la mission autonome, reprises et tests inclus. 0 signifie illimité. La mission est suspendue à la limite. Les missions interactives ne sont pas limitées.', 'Limits gelten für die gesamte autonome Mission inklusive Wiederherstellung und Tests. 0 bedeutet unbegrenzt. Beim Erreichen eines Limits pausiert die Mission. Interaktive Missionen sind nicht begrenzt.');
  add('Learn from experience', 'Leren van ervaring', 'Apprendre de l’expérience', 'Aus Erfahrung lernen');
  add('Reflect on recorded experiments', 'Opgeslagen experimenten evalueren', 'Analyser les expériences enregistrées', 'Gespeicherte Experimente auswerten');
  add('Erase stored memory', 'Opgeslagen geheugen wissen', 'Effacer la mémoire enregistrée', 'Gespeicherten Speicher löschen');
  add('Clear this project', 'Dit project wissen', 'Effacer ce projet', 'Dieses Projekt löschen');
  add('Clear agent memory', 'Agentgeheugen wissen', 'Effacer la mémoire des agents', 'Agentenspeicher löschen');
  add('Clear everything', 'Alles wissen', 'Tout effacer', 'Alles löschen');
  add('Loading memory status…', 'Geheugen laden…', 'Chargement de la mémoire…', 'Speicher wird geladen…');
  add('Memory storage is unavailable in this window.', 'Geheugenopslag is niet beschikbaar in dit venster.', 'Le stockage mémoire est indisponible dans cette fenêtre.', 'Speicher ist in diesem Fenster nicht verfügbar.');
  add('Each project keeps its own memory: open another project to see what it learned there.', 'Elk project heeft eigen geheugen: open een ander project om de daar geleerde kennis te zien.', 'Chaque projet a sa propre mémoire : ouvrez un autre projet pour voir ses connaissances.', 'Jedes Projekt hat einen eigenen Speicher: Öffnen Sie ein anderes Projekt, um dessen Wissen zu sehen.');
  add('Reflection proposes candidate skills from recorded experiments. These suggestions still need validation.', 'Reflectie stelt kandidaatvaardigheden voor op basis van opgeslagen experimenten. Deze voorstellen moeten nog worden gevalideerd.', 'La réflexion propose des compétences candidates à partir des expériences. Ces suggestions restent à valider.', 'Die Reflexion schlägt Fähigkeiten aus gespeicherten Experimenten vor. Diese Vorschläge müssen noch validiert werden.');
  add('Project memory belongs to this workspace. Agent memory is shared across projects. Deletion requires confirmation and cannot be undone.', 'Projectgeheugen hoort bij deze werkruimte. Agentgeheugen wordt gedeeld tussen projecten. Wissen vereist bevestiging en kan niet ongedaan worden gemaakt.', 'La mémoire du projet appartient à cet espace de travail. Celle des agents est partagée entre projets. La suppression nécessite une confirmation et est irréversible.', 'Projektspeicher gehört zu diesem Arbeitsbereich. Agentenspeicher wird projektübergreifend geteilt. Löschen erfordert eine Bestätigung und kann nicht rückgängig gemacht werden.');
  add('Autonoom uitvoeren', 'Autonoom uitvoeren', 'Exécution autonome', 'Autonom ausführen');
  dictionary.get('Autonoom uitvoeren')[0] = 'Run autonomously';
  add('Tests schrijven en uitvoeren', 'Tests schrijven en uitvoeren', 'Écrire et exécuter les tests', 'Tests schreiben und ausführen');
  dictionary.get('Tests schrijven en uitvoeren')[0] = 'Write and run tests';
  add('Snelle modus', 'Snelle modus', 'Mode rapide', 'Schnellmodus');
  dictionary.get('Snelle modus')[0] = 'Fast mode';
  add('Work independently through the mission, including verification. Tests are always enabled in this mode. Changes apply to the next task.', 'Werk zelfstandig door aan de missie, inclusief verificatie. Tests staan in deze modus altijd aan. Wijzigingen gelden voor de volgende opdracht.', 'Poursuit la mission de manière autonome, vérification comprise. Les tests sont toujours activés. Les modifications s’appliquent à la prochaine tâche.', 'Bearbeitet die Mission selbstständig inklusive Prüfung. Tests sind dabei immer aktiv. Änderungen gelten für die nächste Aufgabe.');
  add('Ask the agent to write and run tests for the changes. Autonomous mode always includes this step.', 'Laat de agent tests schrijven en uitvoeren voor de wijzigingen. Autonome modus bevat deze stap altijd.', 'Demande à l’agent d’écrire et d’exécuter des tests. Le mode autonome inclut toujours cette étape.', 'Lässt den Agenten Tests für die Änderungen schreiben und ausführen. Im autonomen Modus ist dieser Schritt immer enthalten.');
  add('Use less reasoning per step for faster, cheaper responses. Difficult problems may need the more thorough standard mode.', 'Gebruik minder denkwerk per stap voor snellere, goedkopere antwoorden. Moeilijke problemen kunnen de grondigere standaardmodus nodig hebben.', 'Réduit le raisonnement par étape pour des réponses plus rapides et économiques. Les problèmes complexes peuvent nécessiter le mode standard.', 'Weniger Denkaufwand pro Schritt für schnellere, günstigere Antworten. Schwierige Probleme benötigen möglicherweise den gründlicheren Standardmodus.');
  add('Require confirmation before shell commands, except trusted commands. Review the trusted list carefully: these commands may run without asking.', 'Vraag bevestiging voor shellopdrachten, behalve vertrouwde opdrachten. Controleer de lijst zorgvuldig: deze opdrachten kunnen zonder toestemming worden uitgevoerd.', 'Demande confirmation avant les commandes shell, sauf celles autorisées. Vérifiez la liste : elles peuvent être exécutées sans confirmation.', 'Verlangt Bestätigung vor Shellbefehlen, außer vertrauenswürdigen Befehlen. Prüfen Sie die Liste: Diese Befehle können ohne Rückfrage laufen.');
  add('Make room for your next idea.', 'Ruimte voor je volgende idee.', 'Place à votre prochaine idée.', 'Raum für Ihre nächste Idee.');
  add('Ask about your code…  (paste an image to attach)', 'Vraag iets over je code… (plak een afbeelding om toe te voegen)', 'Posez une question sur votre code… (collez une image pour la joindre)', 'Fragen zu Ihrem Code… (Bild zum Anhängen einfügen)');
  add('Ask questions, get code suggestions, or use right-click actions.', 'Stel een vraag, verbeter je code of gebruik het rechtermuisknopmenu.', 'Posez des questions, améliorez votre code ou utilisez le menu contextuel.', 'Stellen Sie Fragen, verbessern Sie Code oder nutzen Sie das Kontextmenü.');
  add('Enter to send · Shift+Enter for a new line', 'Enter om te versturen · Shift+Enter voor een nieuwe regel', 'Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne', 'Enter zum Senden · Umschalt+Enter für eine neue Zeile');
  add('Your workspace, your way.', 'Jouw werkruimte, op jouw manier.', 'Votre espace, à votre façon.', 'Ihr Arbeitsbereich, nach Ihren Wünschen.');
  add('Getting started', 'Aan de slag', 'Bien démarrer', 'Erste Schritte');
  add('Choose your provider in Connection, enter its server address and model, then save. Leave the local model empty to detect it automatically.', 'Kies je aanbieder bij Verbinding, vul het serveradres en model in en sla op. Laat het lokale model leeg om het automatisch te herkennen.', 'Choisissez un fournisseur dans Connexion, indiquez le serveur et le modèle, puis enregistrez. Laissez le modèle local vide pour le détecter automatiquement.', 'Wählen Sie unter Verbindung den Anbieter, tragen Sie Server und Modell ein und speichern Sie. Ein leeres lokales Modell wird automatisch erkannt.');
  add('Working with CodeFlare', 'Werken met CodeFlare', 'Travailler avec CodeFlare', 'Mit CodeFlare arbeiten');
  add('Describe your goal in the chat. Attach files with the paperclip or paste an image. Follow progress in the task list. Stop pauses execution; you can resume a paused mission.', 'Beschrijf je doel in de chat. Voeg bestanden toe met de paperclip of plak een afbeelding. Volg de voortgang in de takenlijst. Stop pauzeert de uitvoering; je kunt een gepauzeerde missie hervatten.', 'Décrivez votre objectif dans le chat. Joignez des fichiers avec le trombone ou collez une image. Suivez la liste des tâches. Arrêter suspend l’exécution ; une mission suspendue peut être reprise.', 'Beschreiben Sie Ihr Ziel im Chat. Dateien per Büroklammer anhängen oder ein Bild einfügen. Verfolgen Sie die Aufgabenliste. Stopp pausiert die Ausführung; pausierte Missionen können fortgesetzt werden.');
  add('Understand each option', 'Begrijp elke optie', 'Comprendre chaque option', 'Jede Option verstehen');
  add('Use the ? buttons beside checkboxes for an explanation. Agents controls parallel work; Budget controls mission limits; Memory manages learned knowledge.', 'Klik op ? naast een selectievakje voor uitleg. Agents regelt parallel werk, Budget begrenst missies en Geheugen beheert geleerde kennis.', 'Les boutons ? expliquent les cases à cocher. Agents règle le travail parallèle, Budget les limites et Mémoire les connaissances acquises.', 'Die ?-Schaltflächen erklären die Kontrollkästchen. Agenten steuert parallele Arbeit, Budget die Limits und Speicher das erlernte Wissen.');
  const planWords = [
    ['Plan', 'Tasks', 'Taken', 'Tâches', 'Aufgaben'], ['Nu', 'Now', 'Nu', 'En cours', 'Aktuell'],
    ['✓ Plan afgerond', '✓ All tasks complete', '✓ Alle taken afgerond', '✓ Toutes les tâches terminées', '✓ Alle Aufgaben erledigt'],
    ['Plan uitklappen', 'Expand tasks', 'Taken uitklappen', 'Développer les tâches', 'Aufgaben ausklappen'],
    ['Plan inklappen', 'Collapse tasks', 'Taken inklappen', 'Réduire les tâches', 'Aufgaben einklappen'],
    ['Opmerkingen? Typ ze in de chat.', 'Feedback? Write in the chat.', 'Opmerkingen? Typ ze in de chat.', 'Des remarques ? Écrivez dans le chat.', 'Anmerkungen? Schreiben Sie im Chat.'],
    ['▶ Voer plan uit', '▶ Run plan', '▶ Plan uitvoeren', '▶ Exécuter le plan', '▶ Plan ausführen'],
    ['Hervatten', 'Resume', 'Hervatten', 'Reprendre', 'Fortsetzen'],
    ['Verkennen', 'Explore', 'Verkennen', 'Explorer', 'Erkunden'], ['Ontwerpen', 'Design', 'Ontwerpen', 'Concevoir', 'Entwerfen'],
    ['Bouwen / herstellen', 'Build / repair', 'Bouwen / herstellen', 'Construire / réparer', 'Bauen / reparieren'],
    ['Controleren', 'Verify', 'Controleren', 'Vérifier', 'Prüfen'], ['Opleveren', 'Deliver', 'Opleveren', 'Livrer', 'Ausliefern'],
    ['Bezig', 'Running', 'Bezig', 'En cours', 'Läuft'], ['Gepauzeerd', 'Paused', 'Gepauzeerd', 'En pause', 'Pausiert'],
    ['Afgerond', 'Completed', 'Afgerond', 'Terminé', 'Abgeschlossen'], ['Mislukt', 'Failed', 'Mislukt', 'Échec', 'Fehlgeschlagen'],
    ['Onderbroken', 'Interrupted', 'Onderbroken', 'Interrompu', 'Unterbrochen'],
  ];
  planWords.forEach(([key, ...values]) => dictionary.set(key, values));
  [
    ['Tests gepland', 'Tests planned', 'Tests prévus', 'Tests geplant'],
    ['Tests worden uitgevoerd', 'Tests running', 'Tests en cours', 'Tests laufen'],
    ['Tests geslaagd', 'Tests passed', 'Tests réussis', 'Tests bestanden'],
    ['Tests niet geslaagd', 'Tests failed', 'Échec des tests', 'Tests fehlgeschlagen'],
    ['Tests overgeslagen', 'Tests skipped', 'Tests ignorés', 'Tests übersprungen'],
    ['Geen aparte testopdracht', 'No separate test task', 'Aucune tâche de test distincte', 'Keine separate Testaufgabe'],
    ['Tests onderbroken', 'Tests interrupted', 'Tests interrompus', 'Tests unterbrochen'],
    ['Tests nog niet volledig uitgevoerd', 'Tests not yet complete', 'Tests encore incomplets', 'Tests noch nicht vollständig'],
    ['Agents en geschiedenis', 'Agents and history', 'Agents et historique', 'Agenten und Verlauf'],
    ['Faseovergangen', 'Phase history', 'Historique des phases', 'Phasenverlauf'],
    ['Nog geen subagents gestart.', 'No subagents started yet.', 'Aucun sous-agent démarré.', 'Noch keine Unteragenten gestartet.'],
    ['Nog geen faseovergangen.', 'No phase changes yet.', 'Aucun changement de phase.', 'Noch keine Phasenwechsel.'],
    ['Wacht', 'Queued', 'En attente', 'Wartet'],
    ['Deels afgerond', 'Partially complete', 'Partiellement terminé', 'Teilweise abgeschlossen'],
  ].forEach(([nl, en, fr, de]) => dictionary.set(nl, [en, nl, fr, de]));
  add('The server base address. Leave blank to use the provider default.', 'Het basisadres van de server. Laat leeg voor het standaardadres van de aanbieder.', 'Adresse de base du serveur. Laissez vide pour utiliser celle du fournisseur.', 'Basisadresse des Servers. Leer lassen für die Standardadresse des Anbieters.');
  add('Leave blank for automatic local detection or the provider default model.', 'Laat leeg voor automatische lokale detectie of het standaardmodel van de aanbieder.', 'Laissez vide pour la détection locale ou le modèle par défaut du fournisseur.', 'Leer lassen für lokale Erkennung oder das Standardmodell des Anbieters.');

  function translate(key, language) {
    const index = Math.max(0, languages.indexOf(language));
    if (dictionary.has(key)) return dictionary.get(key)[index];
    const patterns = [
      [/^(\d+)% klaar$/, m => [`${m[1]}% complete`, `${m[1]}% klaar`, `${m[1]} % terminé`, `${m[1]}% erledigt`]],
      [/^(\d+) \/ (\d+) agents actief$/, m => [`${m[1]} / ${m[2]} agents active`, `${m[1]} / ${m[2]} agents actief`, `${m[1]} / ${m[2]} agents actifs`, `${m[1]} / ${m[2]} Agenten aktiv`]],
      [/^Agents \((\d+)\) en geschiedenis \((\d+)\)$/, m => [`Agents (${m[1]}) and history (${m[2]})`, key, `Agents (${m[1]}) et historique (${m[2]})`, `Agenten (${m[1]}) und Verlauf (${m[2]})`]],
      [/^☰ Plan$/, () => ['☰ Tasks', '☰ Taken', '☰ Tâches', '☰ Aufgaben']],
      [/^This project( \(.*\))?: (\d+) skill\(s\), (\d+) recorded experiment\(s\)\.$/, m => [key, `Dit project${m[1] || ''}: ${m[2]} vaardigheden, ${m[3]} opgeslagen experimenten.`, `Ce projet${m[1] || ''} : ${m[2]} compétences, ${m[3]} expériences enregistrées.`, `Dieses Projekt${m[1] || ''}: ${m[2]} Fähigkeiten, ${m[3]} gespeicherte Experimente.`]],
      [/^This project( \(.*\))?: no project storage in this window\.$/, m => [key, `Dit project${m[1] || ''}: geen projectopslag in dit venster.`, `Ce projet${m[1] || ''} : aucun stockage dans cette fenêtre.`, `Dieses Projekt${m[1] || ''}: kein Projektspeicher in diesem Fenster.`]],
      [/^Agent memory \(shared by all projects\): (\d+) skill\(s\)\.$/, m => [key, `Agentgeheugen (gedeeld tussen projecten): ${m[1]} vaardigheden.`, `Mémoire des agents (partagée entre projets) : ${m[1]} compétences.`, `Agentenspeicher (projektübergreifend): ${m[1]} Fähigkeiten.`]],
      [/^(\d+) validated — only validated skills are reused automatically; a candidate first has to pass a mission with test evidence\.$/, m => [key, `${m[1]} gevalideerd — alleen gevalideerde vaardigheden worden automatisch hergebruikt; kandidaten moeten eerst een missie met testbewijs doorstaan.`, `${m[1]} validées — seules les compétences validées sont réutilisées automatiquement ; les candidates doivent réussir une mission avec preuves de tests.`, `${m[1]} validiert — nur validierte Fähigkeiten werden automatisch wiederverwendet; Kandidaten müssen erst eine Mission mit Testnachweisen bestehen.`]],
    ];
    for (const [pattern, values] of patterns) { const match = key.match(pattern); if (match) return values(match)[index]; }
    return key;
  }

  function init(vscode) {
    const state = vscode.getState() || {};
    let language = languages.includes(state.uiLanguage) ? state.uiLanguage : (languages.includes(navigator.language.slice(0, 2)) ? navigator.language.slice(0, 2) : 'en');
    let theme = ['light', 'dark'].includes(state.uiTheme) ? state.uiTheme : (document.body.classList.contains('vscode-light') ? 'light' : 'dark');
    const t = key => translate(key, language);
    const save = () => vscode.setState({ ...(vscode.getState() || {}), uiLanguage: language, uiTheme: theme });
    const make = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
    const panel = document.getElementById('config-panel');
    const overlay = document.getElementById('config-overlay');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'settings-heading');
    const heading = make('div', null, 'settings-heading');
    const title = make('h2', 'Settings'); title.id = 'settings-heading';
    const subtitle = make('p', 'Your workspace, your way.');
    heading.append(title, subtitle); panel.prepend(heading);
    const languageSelect = make('select'); languageSelect.id = 'ui-language';
    languages.forEach(code => { const option = make('option', NATIVE_NAMES[code]); option.value = code; languageSelect.append(option); });
    languageSelect.value = language;
    const languageLabel = make('label', null, 'language-picker'); languageLabel.append(make('span', 'Language'), languageSelect); heading.append(languageLabel);
    const themeButton = make('button', null, 'glass-button theme-toggle'); themeButton.type = 'button'; themeButton.id = 'theme-toggle';
    const helpButton = make('button', 'Help', 'glass-button'); helpButton.type = 'button'; helpButton.id = 'help-button';
    // Four flags in the header, next to Settings: someone who cannot read the
    // current language cannot be expected to find the picker inside Settings.
    const flagGroup = make('div', null, 'language-flags');
    flagGroup.setAttribute('role', 'group');
    const flagButtons = languages.map(code => {
      const button = make('button', null, 'flag-button');
      button.type = 'button';
      button.dataset.language = code;
      button.title = NATIVE_NAMES[code];
      button.setAttribute('aria-label', NATIVE_NAMES[code]);
      button.setAttribute('lang', code);
      button.append(flagSvg(code));
      button.addEventListener('click', () => setLanguage(code));
      flagGroup.append(button);
      return button;
    });
    document.getElementById('config-btn').before(flagGroup, themeButton, helpButton);

    const helpPane = make('div', null, 'config-pane hidden'); helpPane.dataset.pane = 'help';
    const helpSections = [
      ['Getting started', 'Choose your provider in Connection, enter its server address and model, then save. Leave the local model empty to detect it automatically.'],
      ['Working with CodeFlare', 'Describe your goal in the chat. Attach files with the paperclip or paste an image. Follow progress in the task list. Stop pauses execution; you can resume a paused mission.'],
      ['Understand each option', 'Use the ? buttons beside checkboxes for an explanation. Agents controls parallel work; Budget controls mission limits; Memory manages learned knowledge.'],
    ];
    helpSections.forEach(([name, body]) => { const card = make('section', null, 'help-card'); card.append(make('h3', name), make('p', body)); helpPane.append(card); });
    document.querySelector('.config-actions').before(helpPane);
    const helpTab = make('button', 'Help', 'config-tab'); helpTab.type = 'button'; helpTab.dataset.tab = 'help'; document.querySelector('.config-tabs').append(helpTab);
    const selectHelp = () => { document.querySelectorAll('.config-tab').forEach(el => el.classList.toggle('active', el === helpTab)); document.querySelectorAll('.config-pane').forEach(el => el.classList.toggle('hidden', el !== helpPane)); };
    helpTab.addEventListener('click', selectHelp);
    helpButton.addEventListener('click', () => { document.getElementById('config-btn').click(); selectHelp(); helpTab.focus(); });
    // Replace long, mixed-language legacy hints with concise localized explanations.
    document.querySelector('[data-pane="budget"] .config-hint').textContent = 'Limits apply to the whole autonomous mission, including recovery and tests. 0 means unlimited. The mission pauses when a limit is reached. Interactive missions are not limited.';
    const memoryHints = document.querySelectorAll('[data-pane="memory"] .config-hint');
    memoryHints[1].textContent = 'Reflection proposes candidate skills from recorded experiments. These suggestions still need validation.';
    memoryHints[2].textContent = 'Project memory belongs to this workspace. Agent memory is shared across projects. Deletion requires confirmation and cannot be undone.';
    [['cfg-endpoint', 'The server base address. Leave blank to use the provider default.'], ['cfg-model', 'Leave blank for automatic local detection or the provider default model.']].forEach(([id, text]) => {
      const hint = make('small', text); hint.id = `${id}-description`; document.getElementById(id).after(hint); document.getElementById(id).setAttribute('aria-describedby', hint.id);
    });
    const explanations = {
      'mission-autonomous': 'Work independently through the mission, including verification. Tests are always enabled in this mode. Changes apply to the next task.',
      'mission-auto-test': 'Ask the agent to write and run tests for the changes. Autonomous mode always includes this step.',
      'mission-fast': 'Use less reasoning per step for faster, cheaper responses. Difficult problems may need the more thorough standard mode.',
      'cfg-confirm-commands': 'Require confirmation before shell commands, except trusted commands. Review the trusted list carefully: these commands may run without asking.',
    };
    const info = make('dialog', null, 'option-dialog');
    const infoTitle = make('h3'); infoTitle.id = 'option-title'; info.setAttribute('aria-labelledby', infoTitle.id);
    const infoText = make('p'); const infoClose = make('button', 'Close', 'glass-button'); infoClose.type = 'button';
    info.append(infoTitle, infoText, infoClose); document.body.append(info);
    infoClose.addEventListener('click', () => info.close());
    info.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    info.addEventListener('click', event => { if (event.target === info) { const r = info.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) info.close(); } });
    Object.entries(explanations).forEach(([id, explanation]) => {
      const input = document.getElementById(id); const label = input.closest('label');
      const row = make('div', null, 'option-with-help'); label.before(row); row.append(label);
      const button = make('button', '?', 'option-help'); button.type = 'button'; button.setAttribute('aria-haspopup', 'dialog');
      const update = () => { button.setAttribute('aria-label', `${t('Help')}: ${label.textContent.trim()}`); label.title = t(explanation); };
      button.addEventListener('click', () => { infoTitle.textContent = label.textContent.trim(); infoText.textContent = t(explanation); infoClose.textContent = t('Close'); info.showModal(); });
      row.append(button); button.updateLabel = update;
    });

    // Only presentation-owned text is eligible. User messages, code, task names and model output are excluded.
    const roots = '#top-bar, #config-panel, .autonomy-options, .welcome, .input-actions, .plan-head, .plan-now-label, .plan-done-badge, .plan-foot, .mission-phase, .mission-status, .mission-resume, .mission-count, .mission-tests, .mission-details summary, .mission-details h4, .mission-empty, .mission-agent-state';
    const originals = new WeakMap();
    const originalAttributes = new WeakMap();
    function translateAttribute(el, name) {
      const current = el.getAttribute(name); if (!current) return;
      const saved = originalAttributes.get(el) || {};
      const previous = saved[name];
      const original = previous && previous.rendered === current ? previous.original : current;
      let value = t(original);
      if (name === 'placeholder' && original.includes('  —  auto-detected, leave blank to use')) {
        value = original.split('  —  ')[0] + [' — auto-detected; leave blank to use', ' — automatisch herkend; leeg laten om te gebruiken', ' — détecté ; laisser vide pour utiliser', ' — erkannt; zum Verwenden leer lassen'][languages.indexOf(language)];
      }
      saved[name] = { original, rendered: value }; originalAttributes.set(el, saved);
      if (value !== current) el.setAttribute(name, value);
    }
    function translateNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const previous = originals.get(node); const current = node.textContent;
        const original = previous && previous.rendered === current ? previous.original : current;
        const key = original.trim(); const value = key ? original.replace(key, () => t(key)) : original;
        originals.set(node, { original, rendered: value }); if (current !== value) node.textContent = value;
      } else if (node.nodeType === Node.ELEMENT_NODE && !node.matches('input, textarea, #ui-language, .plan-count, #model-chip, .mm-data')) {
        [...node.childNodes].forEach(translateNode);
      }
    }
    function refresh() {
      observer.disconnect();
      document.documentElement.lang = language;
      document.body.dataset.theme = theme;
      document.querySelectorAll(roots).forEach(translateNode);
      // Flags are excluded on purpose: their labels name each language in ITSELF
      // and must never follow the active language (even if the dictionary grows).
      [...document.querySelectorAll('#top-bar [title], #input-area [title], #config-panel [placeholder], #plan-column [title], .autonomy-options[aria-label]')]
        .filter(el => !el.closest('.language-flags')).forEach(el => {
        ['title', 'placeholder', 'aria-label'].forEach(name => translateAttribute(el, name));
      });
      flagButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.language === language)));
      flagGroup.setAttribute('aria-label', t('Language'));
      themeButton.textContent = theme === 'dark' ? '☀' : '☾';
      themeButton.title = t(theme === 'dark' ? 'Light mode' : 'Dark mode'); themeButton.setAttribute('aria-label', themeButton.title);
      languageSelect.setAttribute('aria-label', t('Language'));
      document.getElementById('user-input').placeholder = t('Ask about your code…  (paste an image to attach)');
      document.querySelectorAll('.option-help').forEach(button => button.updateLabel());
      const welcome = document.querySelector('.welcome');
      if (welcome && !welcome.dataset.enhanced) {
        welcome.dataset.enhanced = 'true'; welcome.replaceChildren(make('div', '✦', 'welcome-orb'), make('h3', 'CodeFlare'), make('h2', t('Make room for your next idea.')), make('p', t('Ask questions, get code suggestions, or use right-click actions.')), make('small', t('Enter to send · Shift+Enter for a new line')));
        // Store canonical sources so subsequent language changes are reversible.
        ['Make room for your next idea.', 'Ask questions, get code suggestions, or use right-click actions.', 'Enter to send · Shift+Enter for a new line'].forEach((key, index) => originals.set(welcome.querySelectorAll('h2,p,small')[index].firstChild, { original: key, rendered: t(key) }));
      }
      observer.observe(document.getElementById('chat-container'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder'] });
    }
    const observer = new MutationObserver(records => {
      if (records.some(record => { const el = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement; return el?.closest(roots) || [...record.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE && (node.matches(roots) || node.querySelector(roots))); })) refresh();
    });
    themeButton.addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; save(); refresh(); });
    // One path for both the Settings picker and the header flags, so they never disagree.
    function setLanguage(code) {
      if (!languages.includes(code) || code === language) { return; }
      language = code;
      languageSelect.value = code;
      save();
      refresh();
    }
    languageSelect.addEventListener('change', () => setLanguage(languageSelect.value));
    // Keep keyboard focus within settings and return it to the invoking control.
    let previousFocus;
    const visibility = new MutationObserver(() => {
      const opened = !overlay.classList.contains('hidden');
      [...overlay.parentElement.children].filter(el => el !== overlay).forEach(el => { el.inert = opened; });
      if (!overlay.classList.contains('hidden')) { previousFocus = document.activeElement === document.getElementById('cfg-endpoint') ? document.getElementById('config-btn') : document.activeElement; }
      else previousFocus?.focus();
    });
    visibility.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll('button, input, textarea, select')].filter(el => !el.disabled && el.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
      else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
    });
    refresh();
  }
  return { init, translate, flags: FLAGS, nativeNames: NATIVE_NAMES, languages };
})();
