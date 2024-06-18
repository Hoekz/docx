import { Element } from "xml-js";

import { getFirstLevelElements } from "./util";

// <w:num w:numId="16" w16cid:durableId="1074276204">
// <w:abstractNumId w:val="0" />
// </w:num>
export const appendNumbering = (numberings: Element, abstractNumId: string | number, numId: number): readonly Element[] => {
    const numberingElements = getFirstLevelElements(numberings, "Numbering");
    // eslint-disable-next-line functional/immutable-data
    numberingElements.splice(numberingElements.length - 2, 0, {
        attributes: {
            "w:numId": numId,
        },
        name: "w:num",
        type: "element",
        elements: [
            {
                name: "w:abstractNumId",
                type: "element",
                attributes: {
                    "w:val": abstractNumId,
                },
            },
        ],
    });

    return numberingElements;
};
