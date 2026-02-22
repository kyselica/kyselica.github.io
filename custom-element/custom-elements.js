class selectionImage extends HTMLElement {
    constructor() {
    super();
    }
    connectedCallback() {

        const textColor = this.getAttribute('text-color');
        const imgPath = this.getAttribute('img-path');
        const id = this.getAttribute('id');

        // Add text that should appear on hover
        const hoverText = this.getAttribute('hover-text');
        const textHolder = document.createElement('div')
        textHolder.style.color = textColor;
        textHolder.className = 'textHolderType1';
        hoverText.split('').forEach(char => {
            const character = document.createElement('span')
            const characterText = document.createElement('p')
            characterText.innerText = char;
            characterText.className = "characterType1Text";
            character.appendChild(characterText);
            character.className = "characterType1";
            textHolder.appendChild(character);
        })

        this.appendChild(textHolder);

        const container = document.createElement("div");
        container.className = "imageHolder";

        const insideImageDiv = document.createElement("div");
        insideImageDiv.className = "insideImageDiv";

        const insideImage = document.createElement('img');
        insideImage.src = imgPath;
        insideImage.className = "insideImage";
        insideImage.id = id + "img";
        insideImage.draggable = false;
        
        // Only add hover margin effects on devices that support hover (avoids jank on touch)
        if (window.matchMedia('(hover: hover)').matches) {
            insideImage.addEventListener('mouseover', () => {
                if (matchMedia('(max-width: 768px)').matches) {
                    return;
                }
                this.style.marginRight = "5%";
                this.style.marginLeft = "5%";
                if (id === "homeIm1") {
                    document.getElementById("homeIm2img").style.marginLeft = "10%";
                    document.getElementById("homeIm3img").style.marginLeft = "10%";
                } else if (id === "homeIm2") {
                    document.getElementById("homeIm1img").style.marginRight = "10%";
                    document.getElementById("homeIm3img").style.marginLeft = "10%";
                } else if (id === "homeIm3") {
                    document.getElementById("homeIm1img").style.marginRight = "10%";
                    document.getElementById("homeIm2img").style.marginRight = "10%";
                }
            });
            insideImage.addEventListener('mouseout', () => {
                if (matchMedia('(max-width: 768px)').matches) {
                    return;
                }
                this.style.marginRight = "2.5%";
                this.style.marginLeft = "2.5%";
                if (id === "homeIm1") {
                    document.getElementById("homeIm2img").style.marginLeft = "0%";
                    document.getElementById("homeIm3img").style.marginLeft = "0%";
                } else if (id === "homeIm2") {
                    document.getElementById("homeIm1img").style.marginRight = "0%";
                    document.getElementById("homeIm3img").style.marginLeft = "0%";
                } else if (id === "homeIm3") {
                    document.getElementById("homeIm1img").style.marginRight = "0%";
                    document.getElementById("homeIm2img").style.marginRight = "0%";
                }
            });
        }
        insideImage.addEventListener('click', () => {
            if (PAGE !== 0) {return} // Dont listen to any clicks if we are already switching pages
            // Load next page
            if (hoverText === "awards") {
                PAGE = 1;
                pageIndex = 0;
                switchPages(true, 'home', 'accomplishments');
                let dots = document.getElementsByClassName("acc dot");
                for (let i = 0; i < dots.length; i++) dots[i].className = "acc dot" + (i === 0 ? " active" : "");
                let titleChars = document.getElementsByClassName("acc titleTextCharacter");
                let pageIndicator = document.getElementById("accpageIndicator");
                let activePage = document.getElementsByClassName("page acc active")[0];
                startPageAnimation(titleChars, pageIndicator, activePage, 0);
            } else if (hoverText === "projects") {
                PAGE = 2;
                pageIndex = 0;
                switchPages(true, 'home', 'apps');
                let dots = document.getElementsByClassName("app dot");
                for (let i = 0; i < dots.length; i++) dots[i].className = "app dot" + (i === 0 ? " active" : "");
                let titleChars = document.getElementsByClassName("app titleTextCharacter");
                let pageIndicator = document.getElementById("apppageIndicator");
                let activePage = document.getElementsByClassName("page app active")[0];
                startPageAnimation(titleChars, pageIndicator, activePage, .5);
            } else if (hoverText === "about") {
                PAGE = 3
                // Shrink all of the home images
                Array.from(document.getElementsByClassName("homeImage")).forEach( value => value.style.transform = "scale(0 ,0)");
                animateInAbout();
            }

        });


        container.appendChild(insideImageDiv);
        insideImageDiv.appendChild(insideImage);
        this.appendChild(container);
    }
}

customElements.define('custom-image', selectionImage);
