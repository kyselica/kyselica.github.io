
let appPages = [
    new Page("NextJump",
        "App Developer",
        "NextJump is a Swift app that uses ML to accurately count jump rope jumps in real-time through the device's camera.",
        "Apps/Images/nextJump.png",""),
    new Page("Capstone",
        "Interactive Heart Rythm Library",
        "This project is an interactive heart rhythm library that allows users to view and analyze heart rhythms, accompanied by an animated heart model.",
        "Apps/Images/capstone.png","https://andrewfrueh.github.io/CON-XR_Interactive_Heart_Web/"),
    new Page("Plethos",
        "Solo Developer",
        "Plethos, a sliding puzzle game developed in Unity using C#, showcases a grid-based design with 190 distinct and engaging puzzles.",
        "Apps/Images/plethos.png",""),
    new Page("Simple Matter of Light",
        "Solo Developer",
        "A Simple Matter of Light is a grid-based puzzle game where the user must light up the grid with a limited number of light bulbs. This puzzle game features 420 levels.",
        "Apps/Images/asmol.png","")
];

let pageHolderapp = document.getElementById("apppageHolder");
let apptitleText = document.getElementById("apptitleTextToConvert");
let apptitle = document.getElementById("apptitleText");
let apppageIndicator = document.getElementById("apppageIndicator");

// Split the title paragraph into spans
splitTitle(apptitleText, apptitle, "app titleTextCharacter");

addPageIndicatorDots(apppageIndicator, appPages.length, "app");

window.addEventListener('wheel', function(event) {
    if (PAGE !== 2) {return;}
    scrollCounter += 1;
    setTimeout(function() {
        scrollCounter -= 1;
    }, 100); // 500 milliseconds = 0.5 seconds

    // Debounce.
    if (scrollCounter !== 1) {return;}

    // Dont listen if in a transition
    if (document.getElementsByClassName("page app").length > 1) {return;}
    let su = event.deltaY < 0;
    if (su && pageIndex ===0) {
        // Change pages back to home
        let titleChars = document.getElementsByClassName("app titleTextCharacter");
        let activePage = document.getElementsByClassName("page app active")[0];
        hidePageAnimation(titleChars, apppageIndicator, activePage)
        switchPages(false, 'apps', 'home');
        PAGE = 0;
        pageIndex = 0;
    }
    // Dont listen if at end of list
    if ((!su && pageIndex === appPages.length - 1) || (su && pageIndex === 0)) {return}

    // Change pages
    let dots = document.getElementsByClassName("app dot")
    dots[pageIndex].className = "app dot";
    pageIndex += su ? -1 : 1;
    dots[pageIndex].className = "app dot active";

    let currentPage = document.getElementsByClassName("page app active")[0];
    currentPage.style.transition = "opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1), transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)";
    if (currentPage) {
        currentPage.style.opacity = "0";
        currentPage.style.transform = `translate3d(0, ${su ? "100%" : "-100%"}, 0)`;
        currentPage.className = 'page app';
        setTimeout(function() {deletePage(currentPage, pageHolderapp);}, 500);
    }
    let nextPage = createPage(pageHolderapp, appPages[pageIndex], 'app');
    nextPage.className = 'page app active';
    nextPage.style.opacity = "0";
    nextPage.style.transform = `translate3d(0, ${su ? "-100%" : "100%"}, 0)`;
    nextPage.style.transitionDelay = '0.15s';
    nextPage.style.transition = "opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1), transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)";
    pageHolderapp.appendChild(nextPage);
    _ = nextPage.offsetHeight;
    nextPage.style.opacity = "1";
    nextPage.style.transform = "translate3d(0, 0, 0)";
});

// Create the first page
let firstPageapp = createPage(pageHolderapp, appPages[0], 'app');
firstPageapp.className = "page app active";
firstPageapp.style.opacity = "0";
firstPageapp.style.transition = "opacity 0.5s ease-in-out";
firstPageapp.style.transitionDelay = '1s';
