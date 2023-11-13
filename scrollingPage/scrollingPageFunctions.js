class Page {
    title = "";
    subtitle= ""
    desc = ""
    imagePath = ""
    link=""
    constructor(title, subtitle, desc, imagePath, link) {
        this.title=title;
        this.subtitle=subtitle;
        this.desc=desc;
        this.imagePath=imagePath;
        this.link=link;
    }
}

function leaveAbout() {
    PAGE = 0;
    let about = document.getElementsByClassName("aboutParagraph");
    let email = document.getElementById("email");

    document.getElementById("images").style.pointerEvents = "all";
    email.style.transform = "TranslateY(-100%)";
    Array.from(about).forEach((value, index) => {
        value.style.transitionDelay = `0s`;
        value.style.opacity = "0";
    })

    // Show the home images again
    setTimeout(function() {
        Array.from(document.getElementsByClassName("homeImage")).forEach( value => value.style.transform = "scale(1 ,1)");
    }, 1000); // 500 milliseconds = 0.5 seconds
}
function animateInAbout() {
    let hi = document.getElementById("aboutHi");
    let about = document.getElementsByClassName("aboutParagraph");
    let email = document.getElementById("email");

    document.getElementById("images").style.pointerEvents = "none";

    hi.style.visibility = "visible";
    hi.style.transitionDelay= "0.5s";
    hi.style.transform = "translateY(0%)";

    setTimeout(function() {
        hi.style.opacity = "0";
    }, 1000); // 500 milliseconds = 0.5 seconds

    setTimeout(function() {
        // Reset hi
        email.style.transform = "TranslateY(0%)";
        hi.style.visibility = "hidden";
        hi.style.transform = "translateY(100%)";
        hi.style.opacity = "1";
        Array.from(about).forEach((value, index) => {
            value.style.transitionDelay = `${index * 1.5}s`;
            value.style.opacity = "1";
        })
    }, 2500); // 500 milliseconds = 0.5 seconds
}

let pageIndex = 0;
let PAGE = 0;
let scrollCounter = 0;
function switchPages(Slidedown = true, from, to) {
    let p1 = document.getElementById(from);
    p1.style.transform = `translateY(${Slidedown ? "-" : ""}100%)`
    let p2 = document.getElementById(to);
    p2.style.transform = 'translateY(0%)'
}

function startPageAnimation(titleChars, pageIndicator, activePage, titleDelay) {
    // Play title slide in
    Array.from(titleChars).forEach((char, index) => {
        char.style.transition = "transition: opacity 0.5s ease-in-out, transform 0.5s ease-in-out";
        char.style.opacity = "0";
        char.style.transform = "translateX(-100%)";
        char.style.transitionDelay = `${index * .05 + titleDelay}s`
        let _ = char.offsetHeight;
        char.style.opacity = "1";
        char.style.transform = "translateX(0%)";
    });
    // Fade in the pageIndicator and the first page
    pageIndicator.style.opacity = "0";
    pageIndicator.style.transition = "opacity 1s ease-in-out";
    pageIndicator.style.transitionDelay = `1s`;
    let _ = pageIndicator.offsetHeight;
    pageIndicator.style.opacity = "1";

    activePage.style.opacity = "0";
    activePage.style.transition = "opacity 1s ease-in-out";
    activePage.style.transitionDelay = `1s`;
    _ = activePage.offsetHeight;
    activePage.style.opacity = "1";
}
function hidePageAnimation(titleChars, pageIndicator, activePage) {
    // Play title slide in
    Array.from(titleChars).forEach((char, index) => {
        char.style.opacity = "0";
        char.style.transform = "translateX(-100%)";
        char.style.transitionDelay = `${(titleChars.length - index) * .05}s`
    });
    // Fade in the pageIndicator and the first page
    pageIndicator.style.opacity = "0";
    pageIndicator.style.transitionDelay = `0s`;
    activePage.style.opacity = "0";
}

function splitTitle(titleToConvert, titleTextEle, endingCharClass) {
    titleToConvert.innerText.split("").forEach((char, index) => {
        let span = document.createElement("span");
        span.innerText = char;
        span.className = endingCharClass;
        span.style.animationDelay = `${(1+index) * 0.05 + .1}s`;
        titleTextEle.appendChild(span);
    })
    titleTextEle.removeChild(titleToConvert);
}

function addPageIndicatorDots(pageIndicator, numDots, pageIdentifier) {
    for (let i = 0; i < numDots; i++) {
        let dot = document.createElement('div');
        dot.className = pageIdentifier + " dot" + `${i === 0 ? " active" : ""}`;
        pageIndicator.appendChild(dot);
    }
}

function createPage(pageHolder, pageObject) {
    let page = document.createElement('div');
    page.className = 'page acc';
    pageHolder.appendChild(page);

    let spacer = document.createElement('div');
    spacer.className = "pageSpacer"
    page.appendChild(spacer);

    let textFlexHolder = document.createElement('div');
    textFlexHolder.className = "pageTextFlex"
    textFlexHolder.style.width = `${window.innerWidth * .5}px`;
    page.appendChild(textFlexHolder);

    let textHolder = document.createElement('div');
    textHolder.className = "pageTextHolder"
    textFlexHolder.appendChild(textHolder);

    let title = document.createElement("p");
    title.className = 'pageTitle';
    title.innerText = pageObject.title;
    textHolder.appendChild(title);

    let subtitle = document.createElement('p');
    subtitle.className = 'pageSubtitle';
    subtitle.innerText = pageObject.subtitle;
    textHolder.appendChild(subtitle);

    let desc = document.createElement('p');
    desc.className = 'pageDesc';
    desc.innerText = pageObject.desc;
    textHolder.appendChild(desc);

    spacer = document.createElement('div');
    spacer.className = "pageSpacer"
    page.appendChild(spacer);

    let imgHolder = document.createElement('div');
    imgHolder.className = "pageImageHolder"
    page.appendChild(imgHolder);

    let image = document.createElement("img");
    image.src = pageObject.imagePath;
    image.className = 'pageImg';
    image.draggable = false;
    imgHolder.appendChild(image)

    spacer = document.createElement('div');
    spacer.className = "pageSpacer"
    page.appendChild(spacer);

    return page
}

function deletePage(page, pageHolder) {
    pageHolder.removeChild(page);
}