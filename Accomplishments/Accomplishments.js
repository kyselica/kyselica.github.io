
let accPages = [new Page("Make OH/IO 2023",
    "1st Place Honda Sponsor\n2nd Place Overall",
    "In our Makeathon project, my team and I developed wireless, remote-controlled cars with the capability to autonomously predict and avert collisions. We employed printed trackers and an overhead camera to monitor the vehicles' positions, akin to a GPS system. This setup allowed each car to independently process collision forecasts without relying on a centralized server. Envisioning real-world applications, a system that leverages GPS would facilitate the transformation of traditional vehicles into self-driving ones, offering a cost-effective alternative to extensive camera networks. Moreover, by utilizing radio transmissions for vehicles to broadcast their locations to each other, our approach eliminates the necessity of an internet connection, streamlining communication between cars.",
    "Accomplishments/Images/make_logo_2023.png",""),
    new Page("Hack OH/IO 2022",
        "Amazon Sponsor 1st Place",
        "In our Hackathon project, my team leveraged Amazon Web Services to develop an interactive map that categorizes subjects and adjectives extracted from user interactions with Amazon Alexa. This enabled users to pose intricate inquiries regarding any subject, to which Alexa could respond intelligently using the mapped data. We integrated GPT AI to reconstruct these connections into coherent sentences, allowing Alexa to deliver articulate and precise responses to the user.",
        "Accomplishments/Images/hack-logo.png",""),
    new Page("Jump Rope World Champion",
        "2020-2023 World Triad Champion",
        "Worked with a group of five over a year to choreograph, practice and perform a competitive jump rope routine that won first place in the International Jump Rope Union 2020 Championship. This is not a joke.",
        "Accomplishments/Images/ijruCol.png","")
];

let pageHolderacc = document.getElementById("accpageHolder");
let acctitleText = document.getElementById("acctitleTextToConvert");
let acctitle = document.getElementById("acctitleText");
let accpageIndicator = document.getElementById("accpageIndicator");

// Split the title paragraph into spans
splitTitle(acctitleText, acctitle, "acc titleTextCharacter");

addPageIndicatorDots(accpageIndicator, accPages.length, "acc");

window.addEventListener('wheel', function(event) {
    if (PAGE !== 1) {return}
    scrollCounter += 1;
    setTimeout(function() {
        scrollCounter -= 1;
    }, 100); // 500 milliseconds = 0.5 seconds

    // Debounce.
    if (scrollCounter !== 1) {return;}

    // Dont listen if in a transition
    if (document.getElementsByClassName("page acc").length > 1) {return}
    let su = event.deltaY < 0;
    if (su && pageIndex ===0) {
        // Change pages back to home
        let titleChars = document.getElementsByClassName("acc titleTextCharacter");
        let activePage = document.getElementsByClassName("page acc active")[0];
        hidePageAnimation(titleChars, accpageIndicator, activePage)
        switchPages(false, 'accomplishments', 'home');
        PAGE = 0;
    }
    // Dont listen if at end of list
    if ((!su && pageIndex === accPages.length - 1) || (su && pageIndex === 0)) {return}

    // Change pages
    let dots = document.getElementsByClassName("acc dot")
    dots[pageIndex].className = "acc dot";
    pageIndex += su ? -1 : 1;
    dots[pageIndex].className = "acc dot active";

    let currentPage = document.getElementsByClassName("page acc active")[0];
    currentPage.style.transition = "opacity 0.5s ease-in-out, transform 0.7s ease-in-out";
    // Fade out current page
    if (currentPage) {
        currentPage.style.opacity = "0";
        currentPage.style.transform = `translateY(${su ? "" : "-"}100%)`;
        currentPage.className = 'page acc';
        setTimeout(function() {deletePage(currentPage, pageHolderacc);}, 500);
    }
    // Create another page
    let nextPage = createPage(pageHolderacc, accPages[pageIndex]);
    nextPage.className = 'page acc active';
    nextPage.style.opacity = "0";
    nextPage.style.transform = `translateY(${su ? "-" : ""}100%)`;
    nextPage.style.transitionDelay = '0.2s';
    nextPage.style.transition = "opacity 0.5s ease-in-out, transform 0.7s ease-in-out";
    pageHolderacc.appendChild(nextPage);
    _ = nextPage.offsetHeight;
    nextPage.style.opacity = "1";
    nextPage.style.transform = "translateY(0%)";
});

// Create the first page
let firstPageacc = createPage(pageHolderacc, accPages[0]);
firstPageacc.className = "page acc active";
firstPageacc.style.opacity = "0";
firstPageacc.style.transition = "opacity 0.5s ease-in-out";
firstPageacc.style.transitionDelay = '1s';
