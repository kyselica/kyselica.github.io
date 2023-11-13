
let appPages = [new Page("NextJump",
    "Lead App Developer",
    "NextJump is a cutting-edge iOS app written in Swift that leverages Machine Learning to accurately count jump rope jumps in real-time through the device's camera. This project encompasses a variety of complex and innovative elements, including the integration of TensorFlow predictions with multi-threading techniques, designing and implementing an intuitive and engaging UI/UX, and establishing live analytics. Additionally, it features the setup of in-app purchases, advanced video processing capabilities, adherence to object-oriented design principles, and efficient data management through saving and loading from device storage.",
    "Apps/Images/nextJump.png",""),
    new Page("Plethos",
        "Solo Developer",
        "Plethos, a sliding puzzle game developed in Unity using C#, showcases a grid-based design with 190 distinct and engaging puzzles, complemented by new, randomly generated challenges daily. The completion of this project over a four-month period significantly enhanced my proficiency in UI and gameplay design, the crafting of reusable and efficient code, as well as marketing strategies and best practices in Unity and C#.",
        "Apps/Images/plethos.png",""),
    new Page("Simple Matter of Light",
        "Solo Developer",
        "A Simple Matter of Light was my first game, written in Unity (C#) over 3 months. It is grid-based puzzle game where the user must light up the grid with a limited number of light bulbs. This puzzle game features 420 levels. Through this project I learned how to use the Unity software and became comfortable writing code in C#.  I also created the music for this game!",
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
    }
    // Dont listen if at end of list
    if ((!su && pageIndex === appPages.length - 1) || (su && pageIndex === 0)) {return}

    // Change pages
    let dots = document.getElementsByClassName("app dot")
    dots[pageIndex].className = "app dot";
    pageIndex += su ? -1 : 1;
    dots[pageIndex].className = "app dot active";

    let currentPage = document.getElementsByClassName("page app active")[0];
    currentPage.style.transition = "opacity 0.5s ease-in-out, transform 0.7s ease-in-out";
    // Fade out current page
    if (currentPage) {
        currentPage.style.opacity = "0";
        currentPage.style.transform = `translateY(${su ? "" : "-"}100%)`;
        currentPage.className = 'page app';
        setTimeout(function() {deletePage(currentPage, pageHolderapp);}, 500);
    }
    // Create another page
    let nextPage = createPage(pageHolderapp, appPages[pageIndex]);
    nextPage.className = 'page app active';
    nextPage.style.opacity = "0";
    nextPage.style.transform = `translateY(${su ? "-" : ""}100%)`;
    nextPage.style.transitionDelay = '0.2s';
    nextPage.style.transition = "opacity 0.5s ease-in-out, transform 0.7s ease-in-out";
    pageHolderapp.appendChild(nextPage);
    _ = nextPage.offsetHeight;
    nextPage.style.opacity = "1";
    nextPage.style.transform = "translateY(0%)";
});

// Create the first page
let firstPageapp = createPage(pageHolderapp, appPages[0]);
firstPageapp.className = "page app active";
firstPageapp.style.opacity = "0";
firstPageapp.style.transition = "opacity 0.5s ease-in-out";
firstPageapp.style.transitionDelay = '1s';
