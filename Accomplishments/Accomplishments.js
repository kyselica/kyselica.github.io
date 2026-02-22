
let accPages = [
    new Page("Jump Rope World Champion",
        "2025 IJRU Champion",
        "Placed first in both Male Pairs Double Dutch Team Show at the International Jump Rope Union 2025 Championship in Kawasaki, Japan.",
        "Accomplishments/Images/ijru.png",""),
    new Page("Make OH/IO 2023",
        "1st Place Honda Sponsor\n2nd Place Overall",
        "In our Makeathon project, my team and I developed wireless, remote-controlled cars with the capability to autonomously predict and prevent collisions. We placed fudicals on little cars trackers and used an overhead camera to simulate a GPS system.",
        "Accomplishments/Images/make_logo_2023.png",""),
    new Page("Hack OH/IO 2022",
        "Amazon Sponsor 1st Place",
        "In our Hackathon project, my team developed a semantic memory map that automatically populated from converstations with Amazon Alexa. This enabled users to pose intricate inquiries regarding any subject, to which Alexa could respond intelligently using the mapped data. We integrated GPT AI to reconstruct these connections into coherent sentences.",
        "Accomplishments/Images/hack-logo.png",""),
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
        pageIndex = 0;
    }
    // Dont listen if at end of list
    if ((!su && pageIndex === accPages.length - 1) || (su && pageIndex === 0)) {return}

    // Change pages
    let dots = document.getElementsByClassName("acc dot")
    dots[pageIndex].className = "acc dot";
    pageIndex += su ? -1 : 1;
    dots[pageIndex].className = "acc dot active";

    let currentPage = document.getElementsByClassName("page acc active")[0];
    currentPage.style.transition = "opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1), transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)";
    if (currentPage) {
        currentPage.style.opacity = "0";
        currentPage.style.transform = `translate3d(0, ${su ? "100%" : "-100%"}, 0)`;
        currentPage.className = 'page acc';
        setTimeout(function() {deletePage(currentPage, pageHolderacc);}, 500);
    }
    let nextPage = createPage(pageHolderacc, accPages[pageIndex], 'acc');
    nextPage.className = 'page acc active';
    nextPage.style.opacity = "0";
    nextPage.style.transform = `translate3d(0, ${su ? "-100%" : "100%"}, 0)`;
    nextPage.style.transitionDelay = '0.15s';
    nextPage.style.transition = "opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1), transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)";
    pageHolderacc.appendChild(nextPage);
    _ = nextPage.offsetHeight;
    nextPage.style.opacity = "1";
    nextPage.style.transform = "translate3d(0, 0, 0)";
});

// Create the first page
let firstPageacc = createPage(pageHolderacc, accPages[0], 'acc');
firstPageacc.className = "page acc active";
firstPageacc.style.opacity = "0";
firstPageacc.style.transition = "opacity 0.5s ease-in-out";
firstPageacc.style.transitionDelay = '1s';
