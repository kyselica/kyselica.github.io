/* Kyselica Park: what the plaques say.
   This is the only file to edit when the résumé changes. Each exhibit's `id` matches a site in world.js;
   the order here is the order of the Previous / Next tour. */
(function () {
  'use strict';
  const Park = (window.Park = window.Park || {});

  Park.data = {
    owner: {
      name: 'Erik Kyselica',
      email: 'erik@kyseli.ca',
      resume: 'ErikKyselicaResume.pdf',
      linkedin: 'https://www.linkedin.com/in/erikkyselica',
    },

    exhibits: [
      {
        id: 'about',
        title: "Hi, I'm Erik",
        kicker: 'Welcome kiosk',
        image: { src: 'park/img/erik.jpg', alt: 'Erik Kyselica smiling at a table in a restaurant', portrait: true },
        body: [
          'Welcome to my park. I am a full-stack engineer at Fennec Engineering, I hold two jump rope world titles, and I studied Computer Science and Engineering at Ohio State.',
          'Every exhibit here is something I built, won or worked on. Wander around, read the signs, and mind the creek.',
          'I love projects that make me learn something new. This park is one of them.',
        ],
        links: [
          { label: 'Email me', href: 'mailto:erik@kyseli.ca' },
          { label: 'Résumé (PDF)', href: 'ErikKyselicaResume.pdf' },
          { label: 'LinkedIn', href: 'https://www.linkedin.com/in/erikkyselica' },
        ],
      },
      {
        id: 'dd4',
        title: 'Double Dutch 4s',
        kicker: 'World Champion · IJRU 2025',
        meta: ['Kawasaki, Japan', '2025', 'Team USA'],
        video: { id: 'Cx6yyY4e9PQ', title: 'Double Dutch Pair Freestyle, Team USA: the winning routine' },
        body: [
          "First place in men's four-person double dutch freestyle at the 2025 International Jump Rope Union World Championship in Kawasaki, Japan.",
          'Two turners, two jumpers and 75 seconds on the floor. The IJRU captioned it a "brilliant clean routine". Clean means not one miss.',
        ],
      },
      {
        id: 'teamshow',
        title: 'Team Show',
        kicker: 'World Champion · IJRU 2025',
        meta: ['Kawasaki, Japan', '2025', 'Team USA'],
        video: { id: 'FljdXJxIyhE', title: 'Team USA in the Team Show: the winning routine' },
        image: { src: 'park/img/team-usa.jpg', alt: 'Team USA jumpers in navy jerseys, arms around each other in front of a full crowd' },
        body: [
          'First place in Team Show with Team USA at the same 2025 IJRU World Championship: one choreographed routine with the whole team on the floor.',
        ],
      },
      {
        id: 'fennec',
        title: 'Fennec Engineering',
        kicker: 'Software Full Stack Systems Engineer II',
        meta: ['2023 to present', 'Full-stack web'],
        body: [
          'I joined Fennec as a full-stack intern and co-op in December 2023 and now work there as a Software Full Stack Systems Engineer II, building and maintaining product-driven web applications.',
        ],
        bullets: [
          'Rolled out a new UX and brand refresh across every tool on the platform.',
          "Took the platform's MCP server from nothing to production.",
          'Replaced Draft.js with Lexical as the rich-text editor across the whole platform.',
          'Delivered Copy Project, which lets users duplicate a project across every tool on the platform.',
          'Built user-facing AI suggestion tools that make the products easier to use.',
          'Built the navigation for a UI refresh: breadcrumbs, sidebars and headers.',
          'Make a habit of paying down tech debt, and of turning things around quickly.',
        ],
      },
      {
        id: 'gmi',
        title: 'GMI Companies',
        kicker: 'IT Intern',
        meta: ['May to July 2022', 'Lebanon, Ohio'],
        body: ['My first bugs, which is why this one is the bug house. I spent a summer working in Microsoft Dynamics NAV.'],
        bullets: [
          'Worked as an individual contributor on bug fixes and feature requests.',
          'Managed end-user relationships on my own: gathered requirements, built the feature, then verified it after delivery.',
          'Picked up the fundamentals: object-oriented design, readable code, user-centred and iterative development.',
        ],
      },
      {
        id: 'elite',
        title: 'Elite Jumps',
        kicker: 'Jump rope training app',
        meta: ['iOS and Android', 'React Native · Expo'],
        image: { src: 'park/img/elite-jumps.png', alt: 'Elite Jumps app icon: a cream winged horse on red', icon: true },
        body: [
          'A jump rope training and tracking app. Prop your phone up, start jumping, and it counts your jumps in real time with machine learning that runs on the device.',
          'It also tracks your workouts, teaches new skills through training programs with video tutorials, and keeps your profile and achievements.',
        ],
        tags: ['React Native', 'Expo', 'TypeScript', 'TensorFlow Lite'],
      },
      {
        id: 'nextjump',
        title: 'NextJump',
        kicker: 'Co-founder',
        meta: ['2023 to present', 'AI jump counting'],
        image: { src: 'Apps/Images/nextJump.png', alt: 'NextJump mascot: a kangaroo with a jump rope', icon: true },
        body: [
          'NextJump is building AI that counts jump rope, and I have been its co-founder since 2023.',
          'The mission is AI counting in official competitions. Speed events are still counted by judges with clickers, watching one foot. NextJump wants a camera and a model to count every entry the same way, every time.',
        ],
        bullets: [
          'Built the first NextJump app in Swift: real-time jump counting on the phone, with CoreML.',
          "Took the counting to iOS and Android in Elite Jumps, next door in the pegasus paddock.",
          "In 2026, built the pipeline that runs NextJump's counting on competition footage. It matches every clip to its official entry, so the AI count can be compared with the official score.",
        ],
        note: 'In the yard, the camera and the judge count the same kangaroo, and the board shows both.',
      },
      {
        id: 'hollow',
        title: 'Graveshift: Hollow Creek',
        kicker: 'Solo developer · iOS game',
        meta: ['Free on the App Store', 'November 2026', 'TypeScript · Canvas'],
        image: { src: 'park/img/graveshift.png', alt: 'Graveshift icon: Marlow the night watchman holding a lantern, with glowing-eyed zombies in the dark around him', icon: true, pixel: true },
        body: [
          'An original 8-bit zombie survivors shooter. The power is out in Hollow Creek and the dead are up. They hunt by light, and they are weak in it.',
          'You are on the night shift with a lantern, a weapon and about ten minutes before the airstrike. Fight across four districts to the substation and turn the lights back on.',
        ],
        bullets: [
          'The lantern is your XP bar, your vision, a damage bonus and a panic button in one.',
          'Dodging and reloading are one rhythm: the dash button doubles as an active reload.',
          'Six keepers, seven weapons and 30 cards with set bonuses, a Warden in each district and a final boss.',
          'All the pixel art is drawn in code and all the music is synthesized as it plays. The game ships with no asset files.',
        ],
        tags: ['TypeScript', 'Canvas', 'Capacitor', 'Chiptune synth'],
        links: [{ label: 'Get it on the App Store', href: 'https://apps.apple.com/us/app/graveshift-hollow-creek/id6838020455', primary: true }],
        note: "The keeper in the graveyard is Marlow, the game's night watchman, and the dead are its Shamblers, drawn from the game's own sprites.",
      },
      {
        id: 'osu',
        title: 'The Ohio State University',
        kicker: 'BS Honors, Computer Science and Engineering',
        meta: ['Class of 2026', 'GPA 3.95 / 4.00'],
        body: ['An honors degree in Computer Science and Engineering, with minors in Comparative Studies and Cognitive Science.'],
      },
      {
        id: 'smallosu',
        title: 'Small OSU',
        kicker: 'A live, illustrated map of campus',
        meta: ['Web · Canvas', 'OpenStreetMap'],
        body: [
          "An isometric map of the Ohio State campus that you can drag, zoom and turn. The buses on it are the real ones, the sky is today's sky, and the people and cars are a gentle simulation of a campus going about its day.",
        ],
        bullets: [
          'Every building, street and lamp post comes from OpenStreetMap geometry.',
          'Drawn live in the browser. Tiles are painted by web workers, so dragging stays smooth.',
          'Live campus bus positions, and real weather and daylight over Columbus.',
        ],
        links: [
          { label: 'Open the map', href: 'osu-map/', primary: true },
          { label: "How it's made", href: 'osu-map/about.html' },
        ],
        note: 'An unofficial fan project, not affiliated with the university.',
      },
      {
        id: 'capstone',
        title: 'Interactive Heart Rhythm Library',
        kicker: 'Tech Lead · Senior Capstone',
        meta: ['2025', 'Three.js'],
        image: { src: 'Apps/Images/capstone.png', alt: 'A rendered anatomical heart from the project', icon: true },
        body: [
          'An interactive library of heart rhythms: pick a rhythm, then watch and analyse it next to an animated 3D heart.',
          'As tech lead I bootstrapped the infrastructure and data models, and programmed the Three.js animation and the menus.',
        ],
        links: [{ label: 'Open the project', href: 'https://andrewfrueh.github.io/CON-XR_Interactive_Heart_Web/', primary: true }],
      },
      {
        id: 'make',
        title: 'Make OH/IO 2023',
        kicker: '1st place Honda challenge · 2nd overall',
        meta: ['Makeathon', 'Computer vision'],
        body: [
          'My team built wireless remote-controlled cars that predict and prevent their own collisions. We put fiducial markers on the cars and used an overhead camera as a stand-in for GPS, then predicted each trajectory from that one central tracker.',
          'One of two Honda sponsor challenge wins at OH/IO events between 2022 and 2024.',
        ],
      },
      {
        id: 'hack',
        title: 'Hack OH/IO 2022',
        kicker: '1st place Amazon challenge',
        meta: ['Hackathon', 'AWS · LLMs'],
        body: [
          'We built a semantic memory map that filled itself in from conversations with Amazon Alexa. Tell it facts now and ask it something complicated later: it answers from the map, using AWS RDS and a language model to turn the connections back into sentences.',
        ],
      },
      {
        id: 'plethos',
        title: 'Plethos',
        kicker: 'Solo developer · iOS puzzle game',
        meta: ['iPhone and iPad', '130 puzzles', 'Free, no ads'],
        image: { src: 'park/img/plethos.png', alt: 'Plethos icon: a cleared slot, the red head and an ivory tile in a row', icon: true },
        body: [
          'A calm sliding puzzle. You swipe, and the red head slides until a wall or the edge stops it. Every numbered tile it enters drops by one, and a tile at zero becomes a wall. Clear every tile to solve the level.',
          'I first made Plethos in Unity. The remaster keeps all 130 original puzzles exactly as they were, across five packs, and the original sound. Everything else is new: an interface drawn in code on one canvas, light and dark themes, haptics, and Game Center achievements and a leaderboard.',
        ],
        tags: ['TypeScript', 'Canvas', 'Capacitor', 'Game Center'],
        note: 'The board in the garden is 3×3 level 1, played with its shortest solution.',
      },
      {
        id: 'asmol',
        title: 'A Simple Matter of Light',
        kicker: 'Solo developer',
        meta: ['Puzzle game', '420 levels'],
        image: { src: 'Apps/Images/asmol.png', alt: 'A Simple Matter of Light icon: a yellow light bulb on black', icon: true },
        body: ['A grid puzzle game: light up the whole board with a limited number of light bulbs. It has 420 levels.'],
      },
      {
        id: 'chess',
        title: 'Park Chess',
        kicker: 'Off the clock',
        body: ['When I am not programming I am usually jumping rope or playing chess. I also watch football, when my team is having a good season.'],
      },
      {
        id: 'resume',
        title: 'Gift Shop',
        kicker: 'Take a résumé home',
        body: ['Everything in the park on one page, plus what is on the shelves:'],
        shelves: [
          ['Languages', 'C, C#, Java, TypeScript, JavaScript, Python, SQL'],
          ['Frontend', 'React, CSS, HTML'],
          ['Cloud and tooling', 'AWS, Docker, Terraform, CI/CD, GitLab, Kafka'],
          ['APIs', 'GraphQL, REST, OpenAPI'],
          ['Testing', 'Jest, JUnit'],
        ],
        links: [{ label: 'Download the résumé (PDF)', href: 'ErikKyselicaResume.pdf', primary: true }],
      },
      {
        id: 'contact',
        title: 'Mailbox',
        kicker: 'Say hello',
        body: ['The quickest way to reach me is email.'],
        links: [
          { label: 'erik@kyseli.ca', href: 'mailto:erik@kyseli.ca', primary: true },
          { label: 'LinkedIn', href: 'https://www.linkedin.com/in/erikkyselica' },
        ],
      },
    ],
  };
})();
