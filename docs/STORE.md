# App Store and Google Play: what to fill in

Everything the two store forms ask, ready to paste. Each language has a name,
a subtitle (App Store, 30 characters), keywords (App Store, 100 characters),
a short description (Google Play, 80 characters) and a full description
(both stores). Native speakers should read their language once before launch.

## Facts for both stores

| Question | Answer |
|---|---|
| App name | record.ai |
| Category | Productivity (second: Lifestyle) |
| Price | Free, with in-app subscriptions Solo and Family |
| Age rating | 4+ (Apple) / Everyone (Google): no violence, no user-to-stranger chat; sharing is only with people you type in |
| Support URL | https://record-ai-nina.fly.dev/legal/support.html (move to your domain) |
| Privacy URL | https://record-ai-nina.fly.dev/legal/privacy.html |
| Account deletion URL (Google) | https://record-ai-nina.fly.dev/legal/delete-account.html |
| Sign in for review | The demo account: make it with `fly ssh console -C "node scripts/demo-account.mjs review@your-domain 'a long password'"` |

**Note for the reviewers** (App Store "App Review Information", Google "App access"):

> Log in with the demo account below. It has the Family plan and five example notes.
> Type a note (for example "Dentist Friday 3pm") and save it: the AI gives it a title,
> a group, a priority and a date within a few seconds. Lines starting with "- " make a
> checklist. Tap your initials (top right) for the account, Premium, calendars,
> notifications, download and delete.

## App Privacy (Apple) and Data safety (Google)

Nothing is used for tracking or advertising, nothing is sold, and everything is
encrypted in transit (HTTPS). People can delete their data in the app.

| Data | Collected | Linked to the person | Why |
|---|---|---|---|
| Name, email address | Yes | Yes | Account |
| Notes, lists, photos (User content: other user content, photos) | Yes | Yes | App functionality |
| Calendar events, only when a calendar is connected | Yes | Yes | App functionality |
| User ID | Yes | Yes | App functionality |
| Product interaction (for example "opened the app", "wrote a note", never the text) | Yes | Yes | Analytics, app functionality |
| Crash and error data (server errors, through Sentry) | Yes | Yes (account number) | App functionality |
| Purchases (plan only; card details stay with Stripe, Apple or Google) | Yes | Yes | App functionality |
| Location, contacts, health, browsing, search history, financial info | No | | |

Google also asks: data is encrypted in transit (yes); people can ask for deletion
(yes, in the app and at the deletion URL); data is shared with third parties (no:
Anthropic, Fly.io, Stripe, Resend and Sentry are processors working for record.ai,
which Google does not count as sharing).

Apple asks about the microphone, speech recognition and camera: dictation and photos of notes, only when the person taps them. The purpose strings are already in the iPhone app (ios/RecordAI.swiftpm/Package.swift): "Dictate notes with your voice.", "Turn what you say into note text." and "Take photos to add to your notes."

## Store texts

### English

- **Subtitle:** AI-sorted notes for families
- **Keywords:** notes,to do,family,lists,reminders,planner,shared,calendar,groceries,AI,organizer,work,kids
- **Short description:** Write it down, AI sorts it: notes, lists and dates for work and family.
- **Full description:**

  Work and family, in one place. Write a note, dictate it or snap a photo of the school letter: record.ai gives it a clear title, a group, a priority and its date, so the urgent things are always on top.

  • Lists you can tick: start lines with "- " or paste a list
  • Share a list or a whole group with your partner, live on every device
  • Your calendars both ways: Google, Outlook, iCloud and Calendly
  • Reminders and a morning briefing of your day
  • Work and Family worlds: one switch to see only what matters now
  • Works offline; syncs when you're back online
  • In English, Italian, French, Spanish, Portuguese, German and Polish

  Free to start. Premium (Solo or Family) adds unlimited reminders, more AI every month and daily backups kept 30 days. Your notes stay yours: no ads, no selling data, download or delete everything at any time. Hosted in Frankfurt, Germany.

### Italiano

- **Sottotitolo:** Note ordinate dall'AI
- **Parole chiave:** note,da fare,famiglia,liste,promemoria,agenda,condivise,calendario,spesa,AI,lavoro,bambini
- **Descrizione breve:** Scrivilo, l'AI lo ordina: note, liste e date per lavoro e famiglia.
- **Descrizione completa:**

  Lavoro e famiglia, in un unico posto. Scrivi una nota, dettala o fotografa l'avviso della scuola: record.ai le dà un titolo chiaro, un gruppo, una priorità e la sua data, così le cose urgenti sono sempre in cima.

  • Liste da spuntare: inizia le righe con "- " o incolla una lista
  • Condividi una lista o un intero gruppo con il partner, in tempo reale su ogni dispositivo
  • I tuoi calendari in entrambe le direzioni: Google, Outlook, iCloud e Calendly
  • Promemoria e un riepilogo del mattino
  • Mondi Lavoro e Famiglia: un interruttore per vedere solo ciò che conta ora
  • Funziona offline e si sincronizza quando torni online
  • In italiano, inglese, francese, spagnolo, portoghese, tedesco e polacco

  Gratis per iniziare. Premium (Solo o Famiglia) aggiunge promemoria illimitati, più AI ogni mese e backup giornalieri conservati 30 giorni. Le tue note restano tue: niente pubblicità, nessuna vendita di dati, scarica o elimina tutto quando vuoi. Ospitato a Francoforte, in Germania.

### Français

- **Sous-titre :** Notes triées par l'IA
- **Mots-clés :** notes,tâches,famille,listes,rappels,agenda,partage,calendrier,courses,IA,travail,enfants
- **Description courte :** Notez-le, l'IA trie : notes, listes et dates pour le travail et la famille.
- **Description complète :**

  Travail et famille, au même endroit. Écrivez une note, dictez-la ou photographiez le mot de l'école : record.ai lui donne un titre clair, un groupe, une priorité et sa date, pour que l'urgent soit toujours en haut.

  • Des listes à cocher : commencez les lignes par « - » ou collez une liste
  • Partagez une liste ou tout un groupe avec votre partenaire, en direct sur tous les appareils
  • Vos agendas dans les deux sens : Google, Outlook, iCloud et Calendly
  • Des rappels et un point du matin
  • Mondes Travail et Famille : un bouton pour ne voir que l'essentiel du moment
  • Fonctionne hors ligne, se synchronise au retour du réseau
  • En français, anglais, italien, espagnol, portugais, allemand et polonais

  Gratuit pour commencer. Premium (Solo ou Famille) ajoute des rappels illimités, plus d'IA chaque mois et des sauvegardes quotidiennes gardées 30 jours. Vos notes restent à vous : pas de pub, pas de revente de données, téléchargez ou supprimez tout à tout moment. Hébergé à Francfort, en Allemagne.

### Español

- **Subtítulo:** Notas ordenadas por la IA
- **Palabras clave:** notas,tareas,familia,listas,recordatorios,agenda,compartir,calendario,compra,IA,trabajo,niños
- **Descripción breve:** Apúntalo y la IA lo ordena: notas, listas y fechas para trabajo y familia.
- **Descripción completa:**

  Trabajo y familia, en un solo lugar. Escribe una nota, díctala o haz una foto de la circular del colegio: record.ai le pone un título claro, un grupo, una prioridad y su fecha, para que lo urgente esté siempre arriba.

  • Listas para marcar: empieza las líneas con "- " o pega una lista
  • Comparte una lista o un grupo entero con tu pareja, en directo en todos los dispositivos
  • Tus calendarios en ambos sentidos: Google, Outlook, iCloud y Calendly
  • Recordatorios y un resumen por la mañana
  • Mundos Trabajo y Familia: un interruptor para ver solo lo que importa ahora
  • Funciona sin conexión y se sincroniza al volver
  • En español, inglés, italiano, francés, portugués, alemán y polaco

  Gratis para empezar. Premium (Solo o Familia) añade recordatorios ilimitados, más IA cada mes y copias diarias guardadas 30 días. Tus notas siguen siendo tuyas: sin anuncios ni venta de datos, descarga o elimina todo cuando quieras. Alojado en Fráncfort, Alemania.

### Português

- **Subtítulo:** Notas organizadas pela IA
- **Palavras-chave:** notas,tarefas,família,listas,lembretes,agenda,partilha,calendário,compras,IA,trabalho,filhos
- **Descrição curta:** Escreva e a IA organiza: notas, listas e datas para trabalho e família.
- **Descrição completa:**

  Trabalho e família, num só lugar. Escreva uma nota, dite-a ou fotografe o recado da escola: o record.ai dá-lhe um título claro, um grupo, uma prioridade e a sua data, para o urgente ficar sempre em cima.

  • Listas para marcar: comece as linhas com "- " ou cole uma lista
  • Partilhe uma lista ou um grupo inteiro com o seu par, em tempo real em todos os dispositivos
  • Os seus calendários nos dois sentidos: Google, Outlook, iCloud e Calendly
  • Lembretes e um resumo da manhã
  • Mundos Trabalho e Família: um botão para ver só o que importa agora
  • Funciona offline e sincroniza quando volta a ter rede
  • Em português, inglês, italiano, francês, espanhol, alemão e polaco

  Grátis para começar. O Premium (Solo ou Família) acrescenta lembretes ilimitados, mais IA todos os meses e cópias diárias guardadas 30 dias. As suas notas continuam suas: sem anúncios, sem venda de dados, descarregue ou apague tudo quando quiser. Alojado em Frankfurt, na Alemanha.

### Deutsch

- **Untertitel:** Notizen, sortiert von KI
- **Schlüsselwörter:** Notizen,Aufgaben,Familie,Listen,Erinnerungen,Planer,teilen,Kalender,Einkauf,KI,Arbeit,Kinder
- **Kurzbeschreibung:** Aufschreiben, die KI sortiert: Notizen, Listen, Termine für Job und Familie.
- **Beschreibung:**

  Arbeit und Familie an einem Ort. Schreib eine Notiz, diktiere sie oder fotografiere den Elternbrief: record.ai gibt ihr einen klaren Titel, eine Gruppe, eine Priorität und ihr Datum, damit Dringendes immer oben steht.

  • Listen zum Abhaken: Zeilen mit „- “ beginnen oder eine Liste einfügen
  • Eine Liste oder eine ganze Gruppe mit dem Partner teilen, live auf jedem Gerät
  • Deine Kalender in beide Richtungen: Google, Outlook, iCloud und Calendly
  • Erinnerungen und ein Morgenüberblick
  • Welten Arbeit und Familie: ein Schalter, und du siehst nur, was gerade zählt
  • Funktioniert offline und synchronisiert, sobald du wieder online bist
  • Auf Deutsch, Englisch, Italienisch, Französisch, Spanisch, Portugiesisch und Polnisch

  Kostenlos zum Start. Premium (Solo oder Familie) bietet unbegrenzte Erinnerungen, mehr KI jeden Monat und tägliche Sicherungen für 30 Tage. Deine Notizen bleiben deine: keine Werbung, kein Datenverkauf, alles jederzeit herunterladen oder löschen. Gehostet in Frankfurt.

### Polski

- **Podtytuł:** Notatki porządkowane przez AI
- **Słowa kluczowe:** notatki,zadania,rodzina,listy,przypomnienia,planer,wspólne,kalendarz,zakupy,AI,praca,dzieci
- **Krótki opis:** Zapisz, AI poukłada: notatki, listy i daty do pracy i dla rodziny.
- **Pełny opis:**

  Praca i rodzina w jednym miejscu. Napisz notatkę, podyktuj ją albo zrób zdjęcie pisma ze szkoły: record.ai nada jej jasny tytuł, grupę, priorytet i datę, więc pilne sprawy są zawsze na górze.

  • Listy do odhaczania: zacznij wiersze od „- ” albo wklej listę
  • Udostępnij listę lub całą grupę partnerowi, na żywo na każdym urządzeniu
  • Twoje kalendarze w obie strony: Google, Outlook, iCloud i Calendly
  • Przypomnienia i poranne podsumowanie dnia
  • Światy Praca i Rodzina: jeden przełącznik, by widzieć tylko to, co ważne teraz
  • Działa offline i synchronizuje się po powrocie do sieci
  • Po polsku, angielsku, włosku, francusku, hiszpańsku, portugalsku i niemiecku

  Za darmo na start. Premium (Solo lub Rodzina) daje nielimitowane przypomnienia, więcej AI co miesiąc i codzienne kopie przez 30 dni. Twoje notatki zostają twoje: bez reklam i handlu danymi, pobierz lub usuń wszystko w każdej chwili. Hostowane we Frankfurcie w Niemczech.

## Before you paste: three things to check

- The calendar line only becomes true once the calendar keys are on the server (docs/CALENDARS.md). Until then, leave that line out.
- Reminders on the iPhone and Android apps need Apple's and Google's push keys; until those apps have them, reminders work in the web app (home screen) only.
- Prices in the stores come from App Store Connect and Play Console, not from these texts.
