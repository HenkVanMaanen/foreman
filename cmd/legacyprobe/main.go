package main

import (
	"bytes"
	"fmt"
	"os"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	goldmarkhtml "github.com/yuin/goldmark/renderer/html"
)

func main() {
	markdown, err := os.ReadFile("testdata/content/voorbeeld.md")
	if err != nil {
		panic(err)
	}
	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM, extension.Footnote, extension.Typographer),
		goldmark.WithRendererOptions(goldmarkhtml.WithHardWraps(), goldmarkhtml.WithXHTML()),
	)
	var rendered bytes.Buffer
	if err := md.Convert(markdown, &rendered); err != nil {
		panic(err)
	}
	fmt.Print(rendered.String())
}
