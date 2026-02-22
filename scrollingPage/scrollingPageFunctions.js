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
            value.style.transitionDelay = `${index * .05}s`;
            value.style.opacity = "1";
        })
    }, 2500); // 500 milliseconds = 0.5 seconds
}

let pageIndex = 0;
let PAGE = 0;
let scrollCounter = 0;
function switchPages(Slidedown = true, from, to) {
    let p1 = document.getElementById(from);
    p1.style.transform = `translate3d(0, ${Slidedown ? "-100%" : "100%"}, 0)`;
    let p2 = document.getElementById(to);
    p2.style.transform = 'translate3d(0, 0, 0)';
}

function startPageAnimation(titleChars, pageIndicator, activePage, titleDelay) {
    // Play title slide in
    Array.from(titleChars).forEach((char, index) => {
        char.style.transition = "opacity 0.5s ease-in-out, transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)";
        char.style.opacity = "0";
        char.style.transform = "translate3d(-100%, 0, 0)";
        char.style.transitionDelay = `${index * .05 + titleDelay}s`;
        let _ = char.offsetHeight;
        char.style.opacity = "1";
        char.style.transform = "translate3d(0, 0, 0)";
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
    Array.from(titleChars).forEach((char, index) => {
        char.style.opacity = "0";
        char.style.transform = "translate3d(-100%, 0, 0)";
        char.style.transitionDelay = `${(titleChars.length - index) * .05}s`;
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

function createPage(pageHolder, pageObject, pageType = 'acc') {
    let page = document.createElement('div');
    page.className = `page ${pageType}`;
    pageHolder.appendChild(page);

    let spacer = document.createElement('div');
    spacer.className = "pageSpacer"
    page.appendChild(spacer);

    let textFlexHolder = document.createElement('div');
    textFlexHolder.className = "pageTextFlex"
    // Responsive width: cap at 50% of viewport, min 280px for readability
    let textWidth = Math.min(window.innerWidth * 0.5, Math.max(280, window.innerWidth - 100));
    textFlexHolder.style.width = `${textWidth}px`;
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
    if (pageObject.link !== "") {
        subtitle.innerHTML = `${pageObject.subtitle}<a href="${pageObject.link}" target="_blank" class="pageSubtitleLink"><img src="Images/external-link.png" alt="External Link" class="pageSubtitleLinkImg"></a>`;
    }
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

/**
 * Add touch/swipe support for mobile - dispatches synthetic wheel events
 * so existing scroll logic is reused (debounce, transition checks, etc.)
 */
function initTouchSwipeSupport() {
    let touchStartY = 0;
    const minSwipeDistance = 60;

    document.addEventListener('touchstart', function(e) {
        if (e.touches.length === 1) {
            touchStartY = e.touches[0].clientY;
        }
    }, { passive: true });

    document.addEventListener('touchend', function(e) {
        if (e.changedTouches.length !== 1 || (PAGE !== 1 && PAGE !== 2)) return;

        const touchEndY = e.changedTouches[0].clientY;
        const deltaY = touchStartY - touchEndY;

        if (Math.abs(deltaY) < minSwipeDistance) return;

        // Dispatch synthetic wheel event - reuses all existing scroll logic
        const wheelEvent = new WheelEvent('wheel', {
            deltaY: deltaY > 0 ? 100 : -100,
            bubbles: true
        });
        window.dispatchEvent(wheelEvent);
    }, { passive: true });
}

// Initialize touch support when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTouchSwipeSupport);
} else {
    initTouchSwipeSupport();
}